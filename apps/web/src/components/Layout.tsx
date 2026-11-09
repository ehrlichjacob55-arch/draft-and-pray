import { Link, NavLink, Outlet } from "react-router";
import { useAuth } from "../auth";
import { LeagueProvider, useLeague } from "../league/LeagueProvider";
import { btnSecondary } from "./ui";

const baseNav = [
  { to: "/", label: "Home" },
  { to: "/draft", label: "Draft room" },
  { to: "/standings", label: "Standings" },
  { to: "/my-team", label: "My team" },
  { to: "/rules", label: "Rules" },
] as const;

function Header() {
  const { status, email, signOut } = useAuth();
  const { isCommissioner } = useLeague();
  const items = isCommissioner
    ? [...baseNav, { to: "/commissioner", label: "Commissioner" }]
    : baseNav;
  return (
    <header className="border-b border-border bg-surface px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Draft &amp; Pray</h1>
        {status === "signedIn" ? (
          <div className="flex items-center gap-2 text-sm">
            <span className="max-w-40 truncate text-muted" data-testid="signed-in-email">
              {email}
            </span>
            <button type="button" className={btnSecondary} onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        ) : status === "signedOut" ? (
          <Link to="/signin" className="text-sm text-accent underline">
            Sign in
          </Link>
        ) : null}
      </div>
      {status === "signedIn" && (
        <nav aria-label="Main" className="-mx-1 mt-2 flex flex-wrap gap-1 text-sm">
          {items.map((item) => (
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
      )}
    </header>
  );
}

export function Layout() {
  return (
    <LeagueProvider>
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col">
        <Header />
        <main className="flex-1 p-4">
          <Outlet />
        </main>
      </div>
    </LeagueProvider>
  );
}
