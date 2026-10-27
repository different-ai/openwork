// Windows computer use for OpenWork: the helper behind "This PC". The desktop's
// main process starts it and talks to it over stdin/stdout, one JSON object per
// line. It opens no listener, reads no clipboard and has no privilege beyond the
// signed-in user session that started it. It exits when its parent closes stdin.
//
//   openwork-computer-use.exe --check                one status line, then exit
//   openwork-computer-use.exe serve --host-pid N     {"type":"ready",...}, then requests:
//     windows | focus | capture | input | status     answered in order
//     cancel                                         answered at once; stops a running input
//
// Coordinates are physical pixels (per-monitor DPI aware) and window regions are
// the visible frame. A window's identity is its handle plus its process id and
// start time, so a reused handle never resolves to a different app. Screen pixels
// are returned only while no other app's window overlaps the target; otherwise
// the window renders itself. Input stops as soon as the target loses focus,
// moves, closes, Windows locks, or the host cancels.
//
// Built with the .NET Framework compiler (C# 5) that ships with Windows; keep
// to C# 5 syntax.
using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

static class OpenWorkComputerUse {
  const string Protocol = "openwork.computer-use.windows/1";
  static readonly object OutputGate = new object();
  static readonly object CancelGate = new object();
  static readonly HashSet<string> Cancelled = new HashSet<string>();
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 16 };
  static string activeInput;
  static ManualResetEvent activeCancel;
  static TextWriter output;
  static uint ownPid;
  static uint hostPid;
  static uint ownSession;
  static int ownIntegrity;
  static bool dpiAware;

  // Surfaces that change the permission boundary, run commands or hold
  // credentials, and OpenWork itself: an agent must not grant itself access.
  static readonly HashSet<string> ProtectedApps = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
    "cmd", "powershell", "pwsh", "powershell_ise", "windowsterminal", "openconsole", "conhost", "wt", "mintty", "putty",
    "alacritty", "wezterm-gui", "hyper", "tabby", "kitty", "code", "code - insiders", "vscodium", "cursor", "windsurf",
    "zed", "devenv", "idea", "idea64", "pycharm64", "webstorm64", "rider64", "clion64", "goland64", "phpstorm64",
    "rubymine64", "datagrip64", "rustrover64", "studio64", "fleet", "autohotkey", "autohotkey64", "autohotkeyu64",
    "pad.console.host", "credentialuibroker", "consent", "logonui", "lockapp", "systemsettings", "mmc", "regedit",
    "taskmgr", "sechealthui", "keepass", "keepassxc", "1password", "bitwarden", "chatgpt",
  };
  static readonly HashSet<string> ShellClasses = new HashSet<string> { "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd" };

  sealed class Failure : Exception {
    public readonly string Code;
    public Failure(string code, string message) : base(message) { Code = code; }
  }

  static int Main(string[] args) {
    try { dpiAware = Native.EnablePerMonitorDpi(); } catch { dpiAware = false; }
    ownPid = (uint)Process.GetCurrentProcess().Id;
    ownSession = SessionOf(ownPid);
    ownIntegrity = IntegrityOf(Native.GetCurrentProcess());
    for (int i = 0; i + 1 < args.Length; i++) {
      if (args[i] == "--host-pid") uint.TryParse(args[i + 1], NumberStyles.None, CultureInfo.InvariantCulture, out hostPid);
    }
    output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    if (args.Length > 0 && args[0] == "--check") { Emit(Status()); return 0; }
    if (args.Length > 0 && args[0] == "serve") return Serve();
    Console.Error.WriteLine("Usage: openwork-computer-use --check | serve [--host-pid N]");
    return 2;
  }

  static void Emit(Dictionary<string, object> message) {
    var line = Json.Serialize(message);
    lock (OutputGate) {
      output.Write(line);
      output.Write('\n');
      output.Flush();
    }
  }

  static Dictionary<string, object> Message(params object[] pairs) {
    var message = new Dictionary<string, object>();
    for (int i = 0; i + 1 < pairs.Length; i += 2) message[(string)pairs[i]] = pairs[i + 1];
    return message;
  }

  // ---- Session and desktop -------------------------------------------------

  static string Unavailable() {
    if (!WindowsVersionSupported()) return "windows_version";
    if (!dpiAware) return "dpi_unaware";
    if (ownSession == 0 || !InteractiveStation()) return "noninteractive";
    if (!SessionActive()) return "disconnected";
    if (!InputDesktopIsDefault()) return "desktop_unavailable";
    return null;
  }

  static Dictionary<string, object> Status() {
    var reason = Unavailable();
    return Message("protocol", Protocol, "ok", reason == null, "reason", reason,
      "supported", reason != "windows_version" && reason != "dpi_unaware" && reason != "noninteractive",
      "session", ownSession, "integrity", ownIntegrity);
  }

  static bool WindowsVersionSupported() {
    var info = new Native.OSVERSIONINFOEXW();
    info.dwOSVersionInfoSize = Marshal.SizeOf(typeof(Native.OSVERSIONINFOEXW));
    if (Native.RtlGetVersion(ref info) != 0) return false;
    // Windows 10 1703 introduced per-monitor DPI awareness v2.
    return info.dwMajorVersion > 10 || info.dwMajorVersion == 10 && info.dwBuildNumber >= 15063;
  }

  static bool InteractiveStation() {
    var station = Native.GetProcessWindowStation();
    if (station == IntPtr.Zero) return false;
    var flags = new Native.USEROBJECTFLAGS();
    int needed;
    return Native.GetUserObjectInformationW(station, 1, ref flags, Marshal.SizeOf(typeof(Native.USEROBJECTFLAGS)), out needed) && (flags.dwFlags & 1) != 0;
  }

  static bool SessionActive() {
    IntPtr buffer;
    int bytes;
    if (!Native.WTSQuerySessionInformationW(IntPtr.Zero, 0xFFFFFFFF, 8, out buffer, out bytes)) return false;
    try { return bytes >= 4 && Marshal.ReadInt32(buffer) == 0; }
    finally { Native.WTSFreeMemory(buffer); }
  }

  // The lock screen, a UAC prompt and other secure desktops replace "Default".
  static bool InputDesktopIsDefault() {
    var desktop = Native.OpenInputDesktop(0, false, 0x0001);
    if (desktop == IntPtr.Zero) return false;
    try {
      var name = new StringBuilder(256);
      int needed;
      return Native.GetUserObjectInformationW(desktop, 2, name, name.Capacity * 2, out needed)
        && string.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase);
    } finally { Native.CloseDesktop(desktop); }
  }

  static uint SessionOf(uint pid) {
    uint session;
    return Native.ProcessIdToSessionId(pid, out session) ? session : uint.MaxValue;
  }

  static int IntegrityOf(IntPtr process) {
    IntPtr token;
    if (!Native.OpenProcessToken(process, 0x0008, out token)) return -1;
    try {
      int needed;
      Native.GetTokenInformation(token, 25, IntPtr.Zero, 0, out needed);
      if (needed <= 0 || needed > 4096) return -1;
      var buffer = Marshal.AllocHGlobal(needed);
      try {
        if (!Native.GetTokenInformation(token, 25, buffer, needed, out needed)) return -1;
        var sid = Marshal.ReadIntPtr(buffer);
        int count = Marshal.ReadByte(Native.GetSidSubAuthorityCount(sid));
        if (count < 1) return -1;
        return Marshal.ReadInt32(Native.GetSidSubAuthority(sid, (uint)(count - 1)));
      } finally { Marshal.FreeHGlobal(buffer); }
    } finally { Native.CloseHandle(token); }
  }

  // ---- Processes and windows ----------------------------------------------

  sealed class ProcessInfo {
    public bool Known;
    public string App;
    public string Name;
    public string Started;
    public int Integrity = -1;
    public uint Session = uint.MaxValue;
  }

  sealed class Target {
    public IntPtr Hwnd;
    public uint Pid;
    public string Started;
  }

  static ProcessInfo Inspect(uint pid) {
    var info = new ProcessInfo { Session = SessionOf(pid) };
    var process = Native.OpenProcess(0x1000, false, pid);
    if (process == IntPtr.Zero) return info;
    string path = null;
    try {
      var buffer = new StringBuilder(1024);
      uint size = (uint)buffer.Capacity;
      if (Native.QueryFullProcessImageNameW(process, 0, buffer, ref size)) path = buffer.ToString(0, (int)size);
      long created, exited, kernel, user;
      if (Native.GetProcessTimes(process, out created, out exited, out kernel, out user)) info.Started = created.ToString(CultureInfo.InvariantCulture);
      info.Integrity = IntegrityOf(process);
    } finally { Native.CloseHandle(process); }
    if (path == null || info.Started == null) return info;
    info.Known = true;
    info.App = Path.GetFileNameWithoutExtension(path).ToLowerInvariant();
    info.Name = info.App;
    try {
      var description = FileVersionInfo.GetVersionInfo(path).FileDescription;
      if (!string.IsNullOrWhiteSpace(description)) info.Name = Truncate(description.Trim(), 120);
    } catch { }
    return info;
  }

  static string Restriction(uint pid, ProcessInfo info, IntPtr hwnd) {
    if (pid == ownPid || pid == hostPid || info.Known && info.App.StartsWith("openwork", StringComparison.OrdinalIgnoreCase)) return "host";
    if (info.Session != ownSession) return "other_session";
    if (!info.Known) return "unavailable";
    // Windows blocks input from a lower integrity level; never elevate to get around it.
    if (info.Integrity < 0 || info.Integrity > ownIntegrity) return "elevated";
    if (ProtectedApps.Contains(info.App)) return "protected_app";
    uint affinity;
    if (Native.GetWindowDisplayAffinity(hwnd, out affinity) && affinity != 0) return "capture_protected";
    return null;
  }

  static string RestrictionMessage(string restriction) {
    switch (restriction) {
      case "host": return "OpenWork can't operate its own windows.";
      case "other_session": return "This window belongs to another Windows session.";
      case "elevated": return "This window belongs to an app running with higher privileges (as administrator). OpenWork does not elevate itself to control it.";
      case "protected_app": return "This app can't be operated through computer use: terminals, code editors, password managers and security settings are excluded. Use a structured tool instead.";
      case "capture_protected": return "This window blocks screen capture, so computer use can't see it.";
      default: return "Windows did not allow OpenWork to inspect this app.";
    }
  }

  static bool Cloaked(IntPtr hwnd) {
    int cloaked;
    return Native.DwmGetWindowAttribute(hwnd, 14, out cloaked, 4) == 0 && cloaked != 0;
  }

  static long Style(IntPtr hwnd, int index) {
    return IntPtr.Size == 8 ? Native.GetWindowLongPtr64(hwnd, index).ToInt64() : Native.GetWindowLong32(hwnd, index);
  }

  static string Text(IntPtr hwnd) {
    int length = Native.GetWindowTextLengthW(hwnd);
    if (length <= 0) return "";
    var title = new StringBuilder(Math.Min(length, 2048) + 1);
    Native.GetWindowTextW(hwnd, title, title.Capacity);
    return title.ToString();
  }

  static string ClassOf(IntPtr hwnd) {
    var name = new StringBuilder(256);
    return Native.GetClassNameW(hwnd, name, name.Capacity) > 0 ? name.ToString() : "";
  }

  // The visible frame, without the invisible resize borders of Windows 10+.
  static bool Frame(IntPtr hwnd, out Native.RECT frame) {
    if (Native.DwmGetWindowAttribute(hwnd, 9, out frame, Marshal.SizeOf(typeof(Native.RECT))) == 0 && frame.Right > frame.Left) return true;
    return Native.GetWindowRect(hwnd, out frame);
  }

  static Dictionary<string, object> Region(Native.RECT frame) {
    return Message("x", frame.Left, "y", frame.Top, "width", frame.Right - frame.Left, "height", frame.Bottom - frame.Top);
  }

  static string Truncate(string value, int limit) {
    if (value.Length <= limit) return value;
    int end = limit;
    if (char.IsHighSurrogate(value[end - 1])) end--;
    return value.Substring(0, end);
  }

  static List<Dictionary<string, object>> ListWindows() {
    var handles = new List<IntPtr>();
    Native.EnumWindows(delegate (IntPtr hwnd, IntPtr unused) { if (handles.Count < 2048) handles.Add(hwnd); return true; }, IntPtr.Zero);
    var foreground = Native.GetForegroundWindow();
    var processes = new Dictionary<uint, ProcessInfo>();
    var windows = new List<Dictionary<string, object>>();
    foreach (var hwnd in handles) {
      if (windows.Count >= 128) break;
      if (!Native.IsWindowVisible(hwnd) || Cloaked(hwnd) || ShellClasses.Contains(ClassOf(hwnd))) continue;
      long extended = Style(hwnd, -20);
      if ((extended & 0x80) != 0 && (extended & 0x40000) == 0) continue; // Tool windows, unless shown on the taskbar.
      var title = Text(hwnd);
      if (title.Length == 0) continue;
      uint pid;
      Native.GetWindowThreadProcessId(hwnd, out pid);
      if (pid == 0 || pid == ownPid || pid == hostPid) continue;
      ProcessInfo info;
      if (!processes.TryGetValue(pid, out info)) { info = Inspect(pid); processes[pid] = info; }
      bool minimized = Native.IsIconic(hwnd);
      Native.RECT frame;
      if (minimized) {
        var placement = new Native.WINDOWPLACEMENT();
        placement.length = Marshal.SizeOf(typeof(Native.WINDOWPLACEMENT));
        if (!Native.GetWindowPlacement(hwnd, ref placement)) continue;
        frame = placement.rcNormalPosition;
      } else if (!Frame(hwnd, out frame)) continue;
      if (frame.Right - frame.Left < 80 || frame.Bottom - frame.Top < 60) continue;
      var restriction = Restriction(pid, info, hwnd);
      if (restriction == "host") continue;
      var window = Message("hwnd", hwnd.ToInt64().ToString(CultureInfo.InvariantCulture), "pid", pid, "started", info.Started ?? "0",
        "app", info.Known ? info.App : "unknown", "name", info.Known ? info.Name : "Unknown app", "title", Truncate(title, 500),
        "region", Region(frame), "focused", hwnd == foreground, "minimized", minimized);
      if (restriction != null) {
        window["restricted"] = restriction;
        window["message"] = RestrictionMessage(restriction);
      }
      windows.Add(window);
    }
    return windows;
  }

  static string Field(Dictionary<string, object> source, string key) {
    object value;
    return source != null && source.TryGetValue(key, out value) && value is string ? (string)value : null;
  }

  static long Number(Dictionary<string, object> source, string key, long min, long max) {
    object value;
    if (source == null || !source.TryGetValue(key, out value) || value == null) throw new Failure("invalid_arguments", "Missing " + key + ".");
    double number;
    try { number = Convert.ToDouble(value, CultureInfo.InvariantCulture); } catch { throw new Failure("invalid_arguments", key + " must be a number."); }
    if (double.IsNaN(number) || number < min || number > max || Math.Floor(number) != number) throw new Failure("invalid_arguments", key + " is out of range.");
    return (long)number;
  }

  static Dictionary<string, object> Child(Dictionary<string, object> source, string key) {
    object value;
    return source != null && source.TryGetValue(key, out value) ? value as Dictionary<string, object> : null;
  }

  // Resolves the exact window the host selected, or explains why it is gone.
  static Target Resolve(Dictionary<string, object> request) {
    var window = Child(request, "window");
    long handle;
    var started = Field(window, "started");
    if (!long.TryParse(Field(window, "hwnd") ?? "", NumberStyles.None, CultureInfo.InvariantCulture, out handle) || handle <= 0 || started == null) {
      throw new Failure("invalid_arguments", "A window identity is required.");
    }
    var target = new Target { Hwnd = new IntPtr(handle), Pid = (uint)Number(window, "pid", 1, uint.MaxValue), Started = started };
    uint pid;
    if (!Native.IsWindow(target.Hwnd) || Native.GetWindowThreadProcessId(target.Hwnd, out pid) == 0 || pid != target.Pid) {
      throw new Failure("window_closed", "The selected window closed.");
    }
    var info = Inspect(pid);
    if (info.Started != target.Started) throw new Failure("window_closed", "The selected window closed; its app was restarted.");
    var restriction = Restriction(pid, info, target.Hwnd);
    if (restriction != null) throw new Failure("target_unsupported", RestrictionMessage(restriction));
    return target;
  }

  // The target itself, the windows it owns (dialogs, drop-downs, tooltips) and
  // the menu it has open. Any other window, including an unowned popup of the
  // same app, occludes the target and never receives its input.
  static bool Belongs(Target target, IntPtr hwnd) {
    if (hwnd == IntPtr.Zero) return false;
    var root = Native.GetAncestor(hwnd, 2);
    if (root == target.Hwnd) return true;
    uint pid, targetPid;
    var thread = Native.GetWindowThreadProcessId(root, out pid);
    if (pid != target.Pid) return false;
    if (Native.GetAncestor(root, 3) == target.Hwnd) return true;
    // Win32 menus and combo box lists have no owner window. The selected
    // window's thread names the menu it opened and the combo box it focuses.
    var kind = ClassOf(root);
    if (kind != "#32768" && kind != "ComboLBox" || thread != Native.GetWindowThreadProcessId(target.Hwnd, out targetPid)) return false;
    var info = new Native.GUITHREADINFO();
    info.cbSize = Marshal.SizeOf(typeof(Native.GUITHREADINFO));
    if (!Native.GetGUIThreadInfo(thread, ref info)) return false;
    if (kind == "#32768") return info.hwndMenuOwner != IntPtr.Zero && Native.GetAncestor(info.hwndMenuOwner, 2) == target.Hwnd;
    // Focus is on the combo box, or on the edit field inside an editable one.
    var focus = info.hwndFocus;
    for (int i = 0; i < 2 && focus != IntPtr.Zero; i++, focus = Native.GetParent(focus)) {
      var combo = new Native.COMBOBOXINFO();
      combo.cbSize = Marshal.SizeOf(typeof(Native.COMBOBOXINFO));
      if (Native.GetComboBoxInfo(focus, ref combo) && combo.hwndList == root) return Native.GetAncestor(focus, 2) == target.Hwnd;
    }
    return false;
  }

  static bool Occluded(Target target, Native.RECT frame) {
    var hwnd = Native.GetWindow(target.Hwnd, 3);
    for (int i = 0; hwnd != IntPtr.Zero && i < 4096; i++, hwnd = Native.GetWindow(hwnd, 3)) {
      if (!Native.IsWindowVisible(hwnd) || Native.IsIconic(hwnd) || Cloaked(hwnd)) continue;
      Native.RECT other;
      if (!Frame(hwnd, out other)) continue;
      if (other.Left >= frame.Right || other.Right <= frame.Left || other.Top >= frame.Bottom || other.Bottom <= frame.Top) continue;
      if (!Belongs(target, hwnd)) return true;
    }
    return false;
  }

  static bool CurrentFrame(Target target, out Native.RECT frame) {
    frame = new Native.RECT();
    return Native.IsWindow(target.Hwnd) && !Native.IsIconic(target.Hwnd) && Frame(target.Hwnd, out frame);
  }

  static bool Same(Native.RECT a, Native.RECT b) {
    return a.Left == b.Left && a.Top == b.Top && a.Right == b.Right && a.Bottom == b.Bottom;
  }

  static void WaitUntil(Func<bool> condition, int milliseconds) {
    var clock = Stopwatch.StartNew();
    while (!condition() && clock.ElapsedMilliseconds < milliseconds) Thread.Sleep(15);
  }

  // ---- Requests -----------------------------------------------------------

  static Dictionary<string, object> Focus(Dictionary<string, object> request) {
    var target = Resolve(request);
    if (!InputDesktopIsDefault()) throw new Failure("desktop_unavailable", "Windows is locked or showing a secure prompt.");
    if (Native.IsIconic(target.Hwnd)) {
      Native.ShowWindow(target.Hwnd, 9);
      WaitUntil(delegate { return !Native.IsIconic(target.Hwnd); }, 1000);
    }
    if (!Belongs(target, Native.GetForegroundWindow())) {
      Native.SetForegroundWindow(target.Hwnd);
      WaitUntil(delegate { return Belongs(target, Native.GetForegroundWindow()); }, 1000);
    }
    if (!Belongs(target, Native.GetForegroundWindow())) {
      throw new Failure("focus_refused", "Windows kept another window in front, so nothing was sent. Ask the person to bring the window to the front, then observe again.");
    }
    Native.RECT frame;
    if (!CurrentFrame(target, out frame)) throw new Failure("window_minimized", "The selected window is minimized.");
    return Message("ok", true, "region", Region(frame));
  }

  static Dictionary<string, object> Capture(Dictionary<string, object> request) {
    var target = Resolve(request);
    if (!InputDesktopIsDefault()) throw new Failure("desktop_unavailable", "Windows is locked or showing a secure prompt, so nothing was captured.");
    Native.RECT frame;
    if (!CurrentFrame(target, out frame)) throw new Failure("window_minimized", "The selected window is minimized. Bring it back, then observe again.");
    var region = Child(request, "region");
    int x = (int)Number(region, "x", 0, 16384), y = (int)Number(region, "y", 0, 16384);
    int width = (int)Number(region, "width", 1, 16384), height = (int)Number(region, "height", 1, 16384);
    if (x + width > frame.Right - frame.Left || y + height > frame.Bottom - frame.Top) {
      throw new Failure("window_moved", "The selected window changed size. Observe again.");
    }
    int maxWidth = request.ContainsKey("maxWidth") ? (int)Number(request, "maxWidth", 64, 8192) : 0;
    Bitmap image = null;
    string mode = "screen";
    try {
      if (!Occluded(target, frame)) {
        image = new Bitmap(width, height, PixelFormat.Format24bppRgb);
        try {
          using (var graphics = Graphics.FromImage(image)) {
            graphics.CopyFromScreen(frame.Left + x, frame.Top + y, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
          }
        } catch (System.ComponentModel.Win32Exception) {
          throw new Failure("desktop_unavailable", "Windows did not allow a screen capture right now. Observe again in a moment.");
        }
        Native.RECT after;
        // Another app's window moved over the target while capturing: never return those pixels.
        if (Occluded(target, frame) || !CurrentFrame(target, out after) || !Same(after, frame)) { image.Dispose(); image = null; }
      }
      if (image == null) { mode = "window"; image = RenderWindow(target.Hwnd, frame, x, y, width, height); }
      if (maxWidth > 0 && image.Width > maxWidth) {
        int scaledHeight = Math.Max(1, (int)Math.Round(image.Height * (double)maxWidth / image.Width));
        var scaled = new Bitmap(maxWidth, scaledHeight, PixelFormat.Format24bppRgb);
        using (var graphics = Graphics.FromImage(scaled)) {
          graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
          graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
          graphics.DrawImage(image, 0, 0, maxWidth, scaledHeight);
        }
        image.Dispose();
        image = scaled;
      }
      using (var stream = new MemoryStream()) {
        image.Save(stream, ImageFormat.Png);
        return Message("ok", true, "width", image.Width, "height", image.Height, "mode", mode, "png", Convert.ToBase64String(stream.ToArray()));
      }
    } finally { if (image != null) image.Dispose(); }
  }

  // The window draws itself, so pixels of an overlapping app never appear.
  static Bitmap RenderWindow(IntPtr hwnd, Native.RECT frame, int x, int y, int width, int height) {
    Native.RECT bounds;
    if (!Native.GetWindowRect(hwnd, out bounds)) throw new Failure("window_closed", "The selected window closed.");
    int fullWidth = bounds.Right - bounds.Left, fullHeight = bounds.Bottom - bounds.Top;
    int left = frame.Left - bounds.Left + x, top = frame.Top - bounds.Top + y;
    if (fullWidth <= 0 || fullHeight <= 0 || fullWidth > 16384 || fullHeight > 16384 || left < 0 || top < 0 || left + width > fullWidth || top + height > fullHeight) {
      throw new Failure("capture_unavailable", "This window can't be captured while another window covers it. Bring it to the front, then observe again.");
    }
    using (var whole = new Bitmap(fullWidth, fullHeight, PixelFormat.Format24bppRgb)) {
      using (var graphics = Graphics.FromImage(whole)) {
        var hdc = graphics.GetHdc();
        bool rendered;
        try { rendered = Native.PrintWindow(hwnd, hdc, 2); } finally { graphics.ReleaseHdc(hdc); }
        if (!rendered) throw new Failure("capture_unavailable", "This window can't be captured while another window covers it. Bring it to the front, then observe again.");
      }
      return whole.Clone(new Rectangle(left, top, width, height), PixelFormat.Format24bppRgb);
    }
  }

  // ---- Input --------------------------------------------------------------

  sealed class Step {
    public string Type;
    public int X, Y, DeltaX, DeltaY, Ms;
    public string Text, Key;
    public List<ushort> Modifiers = new List<ushort>();
    public List<Point> Path = new List<Point>();
  }

  sealed class InputContext {
    public Target Target;
    public Native.RECT Frame;
    public ManualResetEvent Cancel;
    public bool Attempted;
    public readonly List<ushort> HeldKeys = new List<ushort>();
    public bool HeldButton;
  }

  static readonly Dictionary<string, ushort> Modifier = new Dictionary<string, ushort> { { "control", 0x11 }, { "shift", 0x10 }, { "alt", 0x12 } };
  static readonly Dictionary<string, ushort> Keys = BuildKeys();
  static readonly HashSet<ushort> ExtendedKeys = new HashSet<ushort> { 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E };

  static Dictionary<string, ushort> BuildKeys() {
    var keys = new Dictionary<string, ushort> {
      { "enter", 0x0D }, { "tab", 0x09 }, { "escape", 0x1B }, { "backspace", 0x08 }, { "delete", 0x2E }, { "insert", 0x2D },
      { "space", 0x20 }, { "left", 0x25 }, { "up", 0x26 }, { "right", 0x27 }, { "down", 0x28 }, { "home", 0x24 }, { "end", 0x23 },
      { "page_up", 0x21 }, { "page_down", 0x22 },
    };
    for (int i = 1; i <= 12; i++) keys["f" + i.ToString(CultureInfo.InvariantCulture)] = (ushort)(0x6F + i);
    for (char c = 'a'; c <= 'z'; c++) keys[c.ToString()] = (ushort)char.ToUpperInvariant(c);
    for (char c = '0'; c <= '9'; c++) keys[c.ToString()] = (ushort)c;
    return keys;
  }

  static List<Step> ParseSteps(Dictionary<string, object> request, int width, int height) {
    object raw;
    var list = request.TryGetValue("steps", out raw) ? raw as IList : null;
    if (list == null || list.Count < 1 || list.Count > 8) throw new Failure("invalid_arguments", "Provide one to eight input steps.");
    var steps = new List<Step>();
    foreach (var item in list) {
      var source = item as Dictionary<string, object>;
      var step = new Step { Type = Field(source, "type") };
      switch (step.Type) {
        case "move": case "click": case "double_click": case "triple_click": case "scroll":
          step.X = (int)Number(source, "x", 0, width - 1);
          step.Y = (int)Number(source, "y", 0, height - 1);
          if (step.Type == "scroll") {
            step.DeltaX = source.ContainsKey("delta_x") ? (int)Number(source, "delta_x", -1200, 1200) : 0;
            step.DeltaY = source.ContainsKey("delta_y") ? (int)Number(source, "delta_y", -1200, 1200) : 0;
          }
          break;
        case "drag":
          var path = source.ContainsKey("path") ? source["path"] as IList : null;
          if (path == null || path.Count < 2 || path.Count > 32) throw new Failure("invalid_arguments", "A drag needs 2 to 32 points.");
          foreach (var point in path) {
            var p = point as Dictionary<string, object>;
            step.Path.Add(new Point((int)Number(p, "x", 0, width - 1), (int)Number(p, "y", 0, height - 1)));
          }
          break;
        case "type":
          step.Text = Field(source, "text");
          if (string.IsNullOrEmpty(step.Text) || step.Text.Length > 8000) throw new Failure("invalid_arguments", "Text must be 1 to 8000 characters.");
          for (int i = 0; i < step.Text.Length; i++) {
            char c = step.Text[i];
            if (c < ' ' && c != '\n' && c != '\r' && c != '\t' || c == '\u007f') throw new Failure("invalid_arguments", "Text can't contain control characters; use key for Enter, Tab and other keys.");
            if (char.IsHighSurrogate(c) && (i + 1 >= step.Text.Length || !char.IsLowSurrogate(step.Text[i + 1]))) throw new Failure("invalid_arguments", "Text contains an incomplete character.");
            if (char.IsLowSurrogate(c) && (i == 0 || !char.IsHighSurrogate(step.Text[i - 1]))) throw new Failure("invalid_arguments", "Text contains an incomplete character.");
          }
          break;
        case "key":
          step.Key = Field(source, "key");
          if (step.Key == null || !Keys.ContainsKey(step.Key)) throw new Failure("unsupported_key", "Use a key listed by computer_discover.");
          break;
        case "wait":
          step.Ms = (int)Number(source, "ms", 0, 3000);
          break;
        default:
          throw new Failure("invalid_arguments", "This input step is not supported on Windows.");
      }
      object modifiers;
      if (source.TryGetValue("modifiers", out modifiers) && modifiers != null) {
        var names = modifiers as IList;
        if (names == null || names.Count > 3) throw new Failure("invalid_arguments", "Unknown modifiers.");
        foreach (var name in names) {
          ushort vk;
          if (!(name is string) || !Modifier.TryGetValue((string)name, out vk) || step.Modifiers.Contains(vk)) throw new Failure("invalid_arguments", "Unknown modifiers.");
          step.Modifiers.Add(vk);
        }
      }
      steps.Add(step);
    }
    return steps;
  }

  static Dictionary<string, object> Input(string id, Dictionary<string, object> request) {
    var target = Resolve(request);
    var expected = Child(request, "expect");
    Native.RECT frame;
    if (!CurrentFrame(target, out frame) || expected == null
      || Number(expected, "x", -1000000, 1000000) != frame.Left || Number(expected, "y", -1000000, 1000000) != frame.Top
      || Number(expected, "width", 1, 1000000) != frame.Right - frame.Left || Number(expected, "height", 1, 1000000) != frame.Bottom - frame.Top) {
      throw new Failure("window_moved", "The selected window moved, resized or was minimized. Observe again; nothing was sent.");
    }
    var steps = ParseSteps(request, frame.Right - frame.Left, frame.Bottom - frame.Top);
    var context = new InputContext { Target = target, Frame = frame, Cancel = new ManualResetEvent(false) };
    lock (CancelGate) {
      if (Cancelled.Remove(id)) { context.Cancel.Close(); return Receipt(context, 0, "cancelled", "Computer input stopped before it started."); }
      activeInput = id;
      activeCancel = context.Cancel;
    }
    int completed = 0;
    try {
      foreach (var step in steps) {
        Check(context);
        Dispatch(context, step);
        completed++;
      }
      return Receipt(context, completed, null, null);
    } catch (Failure failure) {
      return Receipt(context, completed, failure.Code, failure.Message);
    } finally {
      Release(context);
      lock (CancelGate) {
        activeInput = null;
        activeCancel = null;
        Cancelled.Remove(id);
      }
      context.Cancel.Close();
    }
  }

  static Dictionary<string, object> Receipt(InputContext context, int completed, string code, string error) {
    var receipt = Message("ok", true, "completed", completed, "attempted", context.Attempted);
    if (code != null) { receipt["code"] = code; receipt["error"] = error; }
    return receipt;
  }

  // Runs before every step and between short chunks of a step.
  static void Check(InputContext context) {
    if (context.Cancel.WaitOne(0)) throw new Failure("cancelled", "Computer input stopped.");
    if (!InputDesktopIsDefault()) throw new Failure("desktop_unavailable", "Windows locked or showed a secure prompt. No further input was sent.");
    Native.RECT frame;
    if (!CurrentFrame(context.Target, out frame)) throw new Failure("window_closed", "The selected window closed or was minimized. No further input was sent.");
    if (!Same(frame, context.Frame)) throw new Failure("window_moved", "The selected window moved or resized. No further input was sent; observe again.");
    if (!Belongs(context.Target, Native.GetForegroundWindow())) throw new Failure("focus_changed", "Another window came to the front. No further input was sent; observe again.");
  }

  static void Pause(InputContext context, int milliseconds) {
    if (milliseconds > 0 && context.Cancel.WaitOne(milliseconds)) throw new Failure("cancelled", "Computer input stopped.");
  }

  static void Dispatch(InputContext context, Step step) {
    switch (step.Type) {
      case "wait":
        for (int left = step.Ms; left > 0; left -= 50) { Pause(context, Math.Min(50, left)); Check(context); }
        break;
      case "move":
        Pointer(context, step.X, step.Y);
        break;
      case "click": case "double_click": case "triple_click":
        int clicks = step.Type == "click" ? 1 : step.Type == "double_click" ? 2 : 3;
        Pointer(context, step.X, step.Y);
        Hold(context, step.Modifiers);
        for (int i = 0; i < clicks; i++) {
          if (i > 0) { Pause(context, 40); Check(context); Pointer(context, step.X, step.Y); }
          // Down and up go together, so a cancellation never leaves the button held.
          Send(context, MouseEvent(0x0002, 0), MouseEvent(0x0004, 0));
        }
        Unhold(context);
        break;
      case "scroll":
        Pointer(context, step.X, step.Y);
        Wheel(context, step.DeltaY, 0x0800);
        // Positive delta_x scrolls left; a positive horizontal wheel scrolls right.
        Wheel(context, -step.DeltaX, 0x01000);
        break;
      case "drag":
        Pointer(context, step.Path[0].X, step.Path[0].Y);
        context.HeldButton = true;
        Send(context, MouseEvent(0x0002, 0));
        for (int i = 1; i < step.Path.Count; i++) {
          Pause(context, 15);
          Check(context);
          Pointer(context, step.Path[i].X, step.Path[i].Y);
        }
        Send(context, MouseEvent(0x0004, 0));
        context.HeldButton = false;
        break;
      case "type":
        TypeText(context, step.Text);
        break;
      case "key":
        Hold(context, step.Modifiers);
        Key(context, Keys[step.Key]);
        Unhold(context);
        break;
    }
  }

  // Moves the pointer to a point of the target. The point must land on the
  // target (or its own popup), never on a window covering it.
  static void Pointer(InputContext context, int x, int y) {
    int screenX = context.Frame.Left + x, screenY = context.Frame.Top + y;
    if (x < 0 || y < 0 || screenX >= context.Frame.Right || screenY >= context.Frame.Bottom) throw new Failure("out_of_bounds", "That point is outside the selected window.");
    var point = new Native.POINT { X = screenX, Y = screenY };
    if (!Belongs(context.Target, Native.WindowFromPoint(point))) throw new Failure("covered", "Another window covers that point, so nothing was clicked. Observe again.");
    context.Attempted = true;
    if (!Native.SetCursorPos(screenX, screenY)) throw new Failure("input_refused", "Windows refused to move the pointer.");
    Native.POINT now;
    if (!Native.GetCursorPos(out now) || now.X != screenX || now.Y != screenY) throw new Failure("pointer_blocked", "The pointer could not reach that point. Nothing was clicked.");
    // A zero-distance move so the app sees the pointer arrive.
    Send(context, MouseEvent(0x0001, 0));
  }

  static void Wheel(InputContext context, int delta, uint flag) {
    for (int left = delta; left != 0;) {
      int part = Math.Max(-120, Math.Min(120, left));
      Send(context, MouseEvent(flag, part));
      left -= part;
      if (left != 0) { Pause(context, 15); Check(context); }
    }
  }

  static void TypeText(InputContext context, string text) {
    for (int i = 0; i < text.Length;) {
      // Before every character, so a window that takes focus mid-text receives none of it.
      if (i > 0) Check(context);
      char c = text[i];
      if (c == '\r' || c == '\n') {
        Key(context, 0x0D);
        i += c == '\r' && i + 1 < text.Length && text[i + 1] == '\n' ? 2 : 1;
      } else if (c == '\t') {
        Key(context, 0x09);
        i++;
      } else if (char.IsHighSurrogate(c)) {
        Send(context, Unicode(c, 0), Unicode(text[i + 1], 0), Unicode(c, 0x0002), Unicode(text[i + 1], 0x0002));
        i += 2;
      } else {
        Send(context, Unicode(c, 0), Unicode(c, 0x0002));
        i++;
      }
      Pause(context, 2);
    }
  }

  static void Hold(InputContext context, List<ushort> modifiers) {
    foreach (var vk in modifiers) {
      context.HeldKeys.Add(vk);
      Send(context, Keyboard(vk, false));
    }
  }

  static void Unhold(InputContext context) {
    for (int i = context.HeldKeys.Count - 1; i >= 0; i--) {
      var vk = context.HeldKeys[i];
      context.HeldKeys.RemoveAt(i);
      Send(context, Keyboard(vk, true));
    }
  }

  static void Key(InputContext context, ushort vk) {
    Send(context, Keyboard(vk, false), Keyboard(vk, true));
  }

  // Whatever happened, nothing stays held after an input request.
  static void Release(InputContext context) {
    var inputs = new List<Native.INPUT>();
    if (context.HeldButton) inputs.Add(MouseEvent(0x0004, 0));
    for (int i = context.HeldKeys.Count - 1; i >= 0; i--) inputs.Add(Keyboard(context.HeldKeys[i], true));
    context.HeldButton = false;
    context.HeldKeys.Clear();
    if (inputs.Count > 0) Native.SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(Native.INPUT)));
  }

  // Every injection re-verifies the target immediately before SendInput, so a
  // window that took the foreground, or slid under the pointer, since the step
  // began receives nothing. Only Release bypasses this: held keys and buttons
  // must always come back up.
  static void Send(InputContext context, params Native.INPUT[] inputs) {
    if (context.Cancel.WaitOne(0)) throw new Failure("cancelled", "Computer input stopped.");
    if (!Belongs(context.Target, Native.GetForegroundWindow())) throw new Failure("focus_changed", "Another window came to the front. No further input was sent; observe again.");
    foreach (var input in inputs) {
      // Buttons and wheels act on the window under the pointer; plain moves do not.
      if (input.type != 0 || (input.u.mi.dwFlags & ~0x0001u) == 0) continue;
      Native.POINT at;
      if (!Native.GetCursorPos(out at) || !Belongs(context.Target, Native.WindowFromPoint(at))) {
        throw new Failure("covered", "Another window covers that point, so nothing was clicked. Observe again.");
      }
      break;
    }
    context.Attempted = true;
    if (Native.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Native.INPUT))) != inputs.Length) {
      throw new Failure("input_refused", "Windows refused this input; a higher-privilege window or a secure prompt may be in front. Observe before continuing.");
    }
  }

  static Native.INPUT MouseEvent(uint flags, int data) {
    var input = new Native.INPUT { type = 0 };
    input.u.mi.dwFlags = flags;
    input.u.mi.mouseData = unchecked((uint)data);
    return input;
  }

  static Native.INPUT Keyboard(ushort vk, bool up) {
    var input = new Native.INPUT { type = 1 };
    input.u.ki.wVk = vk;
    input.u.ki.wScan = (ushort)Native.MapVirtualKeyW(vk, 0);
    input.u.ki.dwFlags = (up ? 0x0002u : 0u) | (ExtendedKeys.Contains(vk) ? 0x0001u : 0u);
    return input;
  }

  static Native.INPUT Unicode(char c, uint flags) {
    var input = new Native.INPUT { type = 1 };
    input.u.ki.wScan = c;
    input.u.ki.dwFlags = 0x0004u | flags;
    return input;
  }

  // ---- Line protocol ------------------------------------------------------

  static int Serve() {
    var reason = Unavailable();
    if (reason == "windows_version" || reason == "dpi_unaware" || reason == "noninteractive") {
      Emit(Message("type", "error", "code", reason));
      return 3;
    }
    var queue = new BlockingCollection<Dictionary<string, object>>(64);
    var worker = new Thread(delegate () { foreach (var request in queue.GetConsumingEnumerable()) Handle(request); });
    worker.IsBackground = true;
    worker.Start();
    Emit(Message("type", "ready", "protocol", Protocol, "pid", ownPid));
    var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    string line;
    while ((line = input.ReadLine()) != null) {
      if (line.Length == 0) continue;
      Dictionary<string, object> request = null;
      try { if (line.Length <= 1048576) request = Json.Deserialize<Dictionary<string, object>>(line); } catch { }
      var id = Field(request, "id");
      if (request == null || id == null || id.Length == 0 || id.Length > 128) {
        Emit(Message("type", "error", "code", "protocol"));
        break;
      }
      if (Field(request, "op") == "cancel") {
        var target = Field(request, "target");
        lock (CancelGate) {
          if (target != null && target == activeInput && activeCancel != null) activeCancel.Set();
          else if (target != null && Cancelled.Count < 256) Cancelled.Add(target);
        }
        Emit(Message("id", id, "ok", true));
        continue;
      }
      if (!queue.TryAdd(request)) Emit(Message("id", id, "ok", false, "code", "busy", "message", "The Windows helper is busy."));
    }
    // The host went away or closed the session: stop input and release anything held.
    lock (CancelGate) { if (activeCancel != null) activeCancel.Set(); }
    queue.CompleteAdding();
    worker.Join(3000);
    return 0;
  }

  static void Handle(Dictionary<string, object> request) {
    var id = Field(request, "id");
    Dictionary<string, object> result;
    try {
      switch (Field(request, "op")) {
        case "status": result = Status(); result["ok"] = true; break;
        case "windows": result = Message("ok", true, "windows", ListWindows()); break;
        case "focus": result = Focus(request); break;
        case "capture": result = Capture(request); break;
        case "input": result = Input(id, request); break;
        default: throw new Failure("unknown_operation", "This helper operation does not exist.");
      }
    } catch (Failure failure) {
      result = Message("ok", false, "code", failure.Code, "message", failure.Message);
    } catch (Exception error) {
      // No stack traces or paths: the host relays this text to the agent.
      result = Message("ok", false, "code", "helper_failed", "message", "The Windows helper failed (" + error.GetType().Name + ").");
    }
    result["id"] = id;
    Emit(result);
  }
}

static class Native {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct GUITHREADINFO { public int cbSize; public uint flags; public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret; public RECT rcCaret; }
  [StructLayout(LayoutKind.Sequential)]
  public struct COMBOBOXINFO { public int cbSize; public RECT rcItem, rcButton; public uint stateButton; public IntPtr hwndCombo, hwndItem, hwndList; }
  [StructLayout(LayoutKind.Sequential)] public struct USEROBJECTFLAGS { public int fInherit, fReserved, dwFlags; }
  [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT { public int length, flags, showCmd; public POINT ptMinPosition, ptMaxPosition; public RECT rcNormalPosition; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct OSVERSIONINFOEXW {
    public int dwOSVersionInfoSize, dwMajorVersion, dwMinorVersion, dwBuildNumber, dwPlatformId;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szCSDVersion;
    public ushort wServicePackMajor, wServicePackMinor, wSuiteMask;
    public byte wProductType, wReserved;
  }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetWindowTextLengthW(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hwnd, StringBuilder name, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
  [DllImport("user32.dll")] public static extern bool GetComboBoxInfo(IntPtr combo, ref COMBOBOXINFO info);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr64(IntPtr hwnd, int index);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern int GetWindowLong32(IntPtr hwnd, int index);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hwnd, ref WINDOWPLACEMENT placement);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern uint MapVirtualKeyW(uint code, uint type);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr hwnd, out uint affinity);
  [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll")] public static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder info, int length, out int needed);
  [DllImport("user32.dll")] public static extern bool GetUserObjectInformationW(IntPtr handle, int index, ref USEROBJECTFLAGS info, int length, out int needed);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
  [DllImport("user32.dll")] static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT value, int size);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] public static extern bool ProcessIdToSessionId(uint pid, out uint session);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll")] public static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("advapi32.dll")] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll")] public static extern bool GetTokenInformation(IntPtr token, int type, IntPtr info, int length, out int needed);
  [DllImport("advapi32.dll")] public static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
  [DllImport("advapi32.dll")] public static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("wtsapi32.dll")] public static extern bool WTSQuerySessionInformationW(IntPtr server, uint session, int type, out IntPtr buffer, out int bytes);
  [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr memory);
  [DllImport("ntdll.dll")] public static extern int RtlGetVersion(ref OSVERSIONINFOEXW info);

  // Physical pixels everywhere: per-monitor v2, the mode in which window frames,
  // the pointer and screen captures share one coordinate space.
  public static bool EnablePerMonitorDpi() {
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    return GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()) == 2;
  }
}
