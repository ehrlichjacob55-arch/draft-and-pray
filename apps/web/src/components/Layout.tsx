import { NavLink, Outlet } from "react-router";
import { navItems } from "../routes";

export function Layout() {
  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col">
      <header className="border-b border-border bg-surface px-4 py-3">
        <h1 className="text-lg font-semibold">Draft &amp; Pray</h1>
        <nav aria-label="Main" className="-mx-1 mt-2 flex flex-wrap gap-1 text-sm">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                `rounded px-2 py-1 ${isActive ? "bg-accent text-accent-fg" : "text-muted hover:text-text"}`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="flex-1 p-4">
        <Outlet />
      </main>
    </div>
  );
}
