// 小图标（界面按钮用），内联 SVG。

export function IconCamera({ size = 18 }: { size?: number }) {
  return (
    <svg className="ic" viewBox="0 0 24 24" width={size} height={size}>
      <path d="M4 8h3l2-2h6l2 2h3v11H4z" />
      <circle cx="12" cy="13.5" r="3.2" />
    </svg>
  );
}

export function IconFolder({ size = 18 }: { size?: number }) {
  return (
    <svg className="ic" viewBox="0 0 24 24" width={size} height={size}>
      <path d="M3 6h6l2 2h10v11H3z" />
    </svg>
  );
}

export function IconSettings({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1M18.8 5.2l-2.1 2.1M7.3 16.7l-2.1 2.1" />
    </svg>
  );
}

export function IconList({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size}>
      <path d="M4 7h16M4 12h16M4 17h10" />
    </svg>
  );
}

export function IconCaret({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 12 12" width={size} height={size} style={{ fill: "currentColor" }}>
      <path d="M2 4h8L6 9z" />
    </svg>
  );
}

export function IconRestart({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size}>
      <path d="M4 12a8 8 0 1 0 2.5-5.8" />
      <path d="M4 4v4h4" />
    </svg>
  );
}
