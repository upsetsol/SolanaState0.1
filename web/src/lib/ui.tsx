import React, { useState } from "react";

export function Card({ title, right, children }: { title?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="card">
      {(title || right) && (
        <div className="card-h">
          <h3>{title}</h3>
          <div>{right}</div>
        </div>
      )}
      {children}
    </section>
  );
}

export function Btn({
  onClick, children, kind, title, disabled,
}: {
  onClick: () => Promise<unknown> | unknown;
  children: React.ReactNode; kind?: "primary" | "danger"; title?: string; disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={kind ?? ""}
      title={title}
      disabled={busy || disabled}
      onClick={async () => {
        setBusy(true);
        try { await onClick(); } finally { setBusy(false); }
      }}
    >
      {busy ? "…" : children}
    </button>
  );
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <em>{hint}</em>}
    </label>
  );
}

export function TextIn({ value, onChange, placeholder, mono }: { value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean }) {
  return <input className={mono ? "mono" : ""} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} spellCheck={false} />;
}

export function Kv({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="kv">
      <span>{k}</span>
      <b className={mono ? "mono" : ""}>{v}</b>
    </div>
  );
}

export function Badge({ kind, children }: { kind?: "ok" | "warn" | "err" | "info"; children: React.ReactNode }) {
  return <span className={`badge ${kind ?? ""}`}>{children}</span>;
}

export function Copy({ text, children }: { text: string; children?: React.ReactNode }) {
  return (
    <span
      className="copy mono"
      title="Нажмите, чтобы скопировать"
      onClick={() => navigator.clipboard?.writeText(text)}
    >
      {children ?? text}
    </span>
  );
}

export function Note({ kind, children }: { kind?: "warn" | "err" | "info"; children: React.ReactNode }) {
  return <div className={`note ${kind ?? "info"}`}>{children}</div>;
}
