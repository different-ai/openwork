import { Icon, Mark, mix } from "@openwork/presentation";

/** Illustrated app opening; the recording proves the download, not desktop installation. */
export function EmptyChat({ f }: { f: number }) {
  const show = mix(f, 0, 32);
  return (
    <div
      style={{
        width: 1600,
        height: 1000,
        display: "flex",
        color: "#272b25",
        background: "#fafbf8",
        opacity: show,
        transform: `translateY(${mix(f, 0, 32, 25, 0)}px) scale(${mix(f, 0, 32, 0.975, 1)})`,
        transformOrigin: "50% 55%",
      }}
    >
      <div
        style={{
          width: 246,
          background: "#f0f2ec",
          borderRight: "1px solid #e5e8de",
          padding: "23px 18px",
          position: "relative",
        }}
      >
        <div style={{ display: "flex", gap: 7, margin: "0 0 32px 5px" }}>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                width: 10,
                height: 10,
                borderRadius: 8,
                background: "#c8cebf",
              }}
            />
          ))}
        </div>
        <div
          style={{
            display: "flex",
            gap: 11,
            alignItems: "center",
            fontSize: 17,
            fontWeight: 600,
            padding: 10,
          }}
        >
          <Mark size={23} />
          Studio
          <span
            style={{
              marginLeft: "auto",
              transform: "rotate(90deg)",
              display: "flex",
              color: "#9ba38f",
            }}
          >
            <Icon name="chevron" size={13} />
          </span>
        </div>
        <div
          style={{
            background: "#fff",
            border: "1px solid #dde3d4",
            boxShadow: "0 1px 3px #19321505",
            padding: "12px 13px",
            borderRadius: 9,
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontSize: 14,
            marginTop: 23,
          }}
        >
          <Icon name="plus" />
          New task
          <span style={{ marginLeft: "auto", fontSize: 10, color: "#9ba48e" }}>
            ⌘ N
          </span>
        </div>
        {[
          ["grid", "Apps"],
          ["folder", "Files"],
        ].map(([icon, label]) => (
          <div
            key={label}
            style={{
              padding: "16px 13px",
              display: "flex",
              gap: 12,
              color: "#7d8872",
              fontSize: 13,
            }}
          >
            <Icon name={icon} />
            {label}
          </div>
        ))}
        <div
          style={{
            fontSize: 10,
            letterSpacing: 1.5,
            color: "#9da68f",
            margin: "32px 13px 16px",
          }}
        >
          TASKS
        </div>
        <div style={{ color: "#a1aa95", fontSize: 12, padding: "0 13px" }}>
          Your next idea starts here.
        </div>
        <div
          style={{
            position: "absolute",
            bottom: 28,
            left: 31,
            right: 28,
            display: "flex",
            alignItems: "center",
            gap: 11,
            fontSize: 13,
          }}
        >
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              background: "#dce4d2",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 12,
            }}
          >
            A
          </div>
          Alex
          <span style={{ marginLeft: "auto", color: "#8f9c81" }}>
            <Icon name="settings" />
          </span>
        </div>
      </div>
      <div style={{ flex: 1, position: "relative" }}>
        <div
          style={{
            height: 64,
            padding: "0 28px",
            display: "flex",
            alignItems: "center",
            borderBottom: "1px solid #eef0e8",
            fontSize: 13,
            color: "#8d9783",
          }}
        >
          New task
          <span style={{ marginLeft: "auto", fontSize: 12 }}>Studio</span>
        </div>
        <div
          style={{
            position: "absolute",
            width: 728,
            left: "50%",
            top: 305,
            transform: "translateX(-50%)",
            textAlign: "center",
          }}
        >
          <div
            style={{
              marginBottom: 23,
              display: "flex",
              justifyContent: "center",
              opacity: mix(f, 12, 40),
            }}
          >
            <Mark size={36} />
          </div>
          <div
            style={{
              fontSize: 35,
              letterSpacing: -1.1,
              fontWeight: 550,
              opacity: mix(f, 12, 40),
            }}
          >
            What do you need done?
          </div>
          <div
            style={{
              fontSize: 15,
              color: "#929a89",
              marginTop: 11,
              opacity: mix(f, 18, 45),
            }}
          >
            Describe it in plain language
          </div>
          <div
            style={{
              marginTop: 33,
              height: 154,
              padding: 21,
              textAlign: "left",
              borderRadius: 17,
              background: "#fff",
              border: "1px solid #dce3d2",
              boxShadow: "0 12px 38px #40512e08,0 2px 4px #40512e04",
              position: "relative",
              opacity: mix(f, 20, 50),
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 3,
                fontSize: 16,
                color: "#a2aa98",
              }}
            >
              <span
                style={{
                  height: 21,
                  width: 1,
                  background: "#52664a",
                  opacity: Math.floor(f / 16) % 2 === 0 ? 1 : 0,
                }}
              />
              Ask for anything...
            </div>
            <div
              style={{
                position: "absolute",
                bottom: 18,
                left: 20,
                right: 20,
                display: "flex",
                alignItems: "center",
                gap: 15,
                color: "#9aa58d",
              }}
            >
              <Icon name="plus" />
              <div
                style={{
                  fontSize: 12,
                  padding: "5px 9px",
                  borderRadius: 6,
                  border: "1px solid #eef0e9",
                }}
              >
                Choose a model <span style={{ marginLeft: 7 }}>⌄</span>
              </div>
              <div
                style={{
                  marginLeft: "auto",
                  background: "#e6ebdf",
                  borderRadius: 9,
                  width: 33,
                  height: 33,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transform: "rotate(-90deg)",
                }}
              >
                <Icon name="arrow" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
