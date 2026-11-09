export function Placeholder({ title, note }: { title: string; note: string }) {
  return (
    <section>
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="mt-2 text-muted">{note}</p>
    </section>
  );
}
