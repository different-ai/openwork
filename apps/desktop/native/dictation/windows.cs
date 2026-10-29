// Windows dictation for the composer through Windows.Media.SpeechRecognition.
// Windows' dictation grammar uses Microsoft's online speech recognition (the
// Settings > Privacy > Speech switch). Nothing is written to disk, and the
// process exits when its parent closes stdin.
//
// Same line protocol as main.swift:
//   {"type":"ready"} | {"type":"result","segments":[...]} | {"type":"error","code":"..."} | {"type":"end"}
// stdin: "stop" flushes the final words and ends; EOF cancels.
//
// Built with the .NET Framework compiler (C# 5) that ships with Windows; keep
// to C# 5 syntax.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Windows.Globalization;
using Windows.Media.SpeechRecognition;

static class OpenWorkDictation {
  static readonly object Gate = new object();
  static readonly List<string> Committed = new List<string>();
  static readonly ManualResetEvent Done = new ManualResetEvent(false);
  static string partial = "";
  static bool stopping;
  static bool finished;
  static SpeechRecognizer recognizer;

  static string Quote(string value) {
    var builder = new StringBuilder("\"");
    foreach (var c in value) {
      if (c == '"' || c == '\\') builder.Append('\\').Append(c);
      else if (c < ' ') builder.Append("\\u").Append(((int)c).ToString("x4"));
      else builder.Append(c);
    }
    return builder.Append('"').ToString();
  }

  static void Emit(string json) {
    Console.Out.WriteLine(json);
    Console.Out.Flush();
  }

  static void SendResult() {
    var segments = new List<string>(Committed);
    if (partial.Length > 0) segments.Add(partial);
    var parts = new List<string>();
    foreach (var segment in segments) parts.Add(Quote(segment));
    Emit("{\"type\":\"result\",\"segments\":[" + string.Join(",", parts) + "]}");
  }

  static void Finish(string error) {
    lock (Gate) {
      if (finished) return;
      finished = true;
      if (partial.Length > 0) { Committed.Add(partial); partial = ""; }
      if (Committed.Count > 0) SendResult();
      if (error != null) Emit("{\"type\":\"error\",\"code\":" + Quote(error) + "}");
      Emit("{\"type\":\"end\"}");
    }
    Done.Set();
  }

  /// Maps Windows failures onto the Web Speech codes the composer explains.
  static string ErrorCode(Exception error) {
    var hresult = (uint)Marshal.GetHRForException(error);
    if (hresult == 0x80045509) return "service-not-allowed"; // Online speech recognition is off.
    if (hresult == 0x80070005) return "not-allowed";          // Microphone access denied.
    return "network";
  }

  static async Task Start(string language) {
    try {
      recognizer = new SpeechRecognizer(new Language(language));
    } catch (Exception) {
      Finish("language-not-supported");
      return;
    }
    recognizer.Constraints.Add(new SpeechRecognitionTopicConstraint(SpeechRecognitionScenario.Dictation, "dictation"));
    var compiled = await recognizer.CompileConstraintsAsync();
    if (compiled.Status != SpeechRecognitionResultStatus.Success) {
      Finish(compiled.Status == SpeechRecognitionResultStatus.NetworkFailure ? "network" : "language-not-supported");
      return;
    }
    var session = recognizer.ContinuousRecognitionSession;
    // Pauses are part of dictating; only an explicit stop ends the session.
    session.AutoStopSilenceTimeout = TimeSpan.FromMinutes(10);
    recognizer.HypothesisGenerated += (sender, args) => {
      lock (Gate) {
        if (finished) return;
        partial = args.Hypothesis.Text ?? "";
        SendResult();
      }
    };
    session.ResultGenerated += (sender, args) => {
      lock (Gate) {
        if (finished) return;
        var text = args.Result.Text ?? "";
        if (args.Result.Confidence != SpeechRecognitionConfidence.Rejected && text.Length > 0) Committed.Add(text);
        partial = "";
        SendResult();
      }
    };
    session.Completed += (sender, args) => {
      bool restart;
      lock (Gate) {
        restart = !stopping && !finished && args.Status == SpeechRecognitionResultStatus.TimeoutExceeded;
      }
      if (restart) { Restart(); return; }
      Finish(stopping || args.Status == SpeechRecognitionResultStatus.Success ? null
        : args.Status == SpeechRecognitionResultStatus.AudioQualityFailure ? "audio-capture"
        : args.Status == SpeechRecognitionResultStatus.MicrophoneUnavailable ? "audio-capture"
        : "network");
    };
    await session.StartAsync();
    Emit("{\"type\":\"ready\"}");
  }

  static async void Restart() {
    try { await recognizer.ContinuousRecognitionSession.StartAsync(); }
    catch (Exception error) { Finish(ErrorCode(error)); }
  }

  static async void Stop() {
    lock (Gate) {
      if (stopping || finished) return;
      stopping = true;
    }
    // Inside the composer's 1.5 s stop window, so the last words still land.
    var timeout = new Timer(state => Finish(null), null, 1200, Timeout.Infinite);
    try { await recognizer.ContinuousRecognitionSession.StopAsync(); }
    catch (Exception) { Finish(null); }
    GC.KeepAlive(timeout);
  }

  static int Main(string[] args) {
    Console.OutputEncoding = new UTF8Encoding(false);
    var language = "en-US";
    for (var index = 0; index + 1 < args.Length; index++) {
      if (args[index] == "--locale") language = args[index + 1];
    }
    var input = new Thread(() => {
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        if (line.Trim() == "stop" && recognizer != null) Stop();
      }
      Finish(null);
    });
    input.IsBackground = true;
    input.Start();
    Task.Run(async () => {
      try { await Start(language); }
      catch (Exception error) { Finish(ErrorCode(error)); }
    });
    Done.WaitOne();
    if (recognizer != null) {
      try { recognizer.Dispose(); } catch (Exception) { }
    }
    return 0;
  }
}
