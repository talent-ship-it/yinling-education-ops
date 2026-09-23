export function AuthStatusScreen({ title, detail }: { title: string; detail: string }) {
  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand-mark">吟</div>
        <p className="eyebrow">内部教务系统</p>
        <h1>{title}</h1>
        <p className="login-copy">{detail}</p>
      </section>
    </main>
  );
}
