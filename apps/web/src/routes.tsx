import type { RouteObject } from "react-router";
import { Layout } from "./components/Layout";
import { Placeholder } from "./pages/Placeholder";
import { LeagueHome } from "./pages/LeagueHome";

export const navItems = [
  { to: "/", label: "League" },
  { to: "/draft", label: "Draft room" },
  { to: "/standings", label: "Standings" },
  { to: "/my-team", label: "My team" },
  { to: "/rules", label: "Rules" },
  { to: "/commissioner", label: "Commissioner" },
  { to: "/sign-in", label: "Sign in" },
] as const;

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <LeagueHome /> },
      {
        path: "sign-in",
        element: (
          <Placeholder title="Sign in" note="Email one-time-code sign in arrives in task 3." />
        ),
      },
      {
        path: "draft",
        element: <Placeholder title="Draft room" note="Live snake draft (task 7)." />,
      },
      {
        path: "standings",
        element: <Placeholder title="Standings" note="Cumulative points (task 11)." />,
      },
      {
        path: "my-team",
        element: <Placeholder title="My team" note="Your locked roster (task 11)." />,
      },
      {
        path: "rules",
        element: <Placeholder title="Rules & scoring" note="League rules (task 11)." />,
      },
      {
        path: "commissioner",
        element: <Placeholder title="Commissioner" note="Admin console (task 11)." />,
      },
      { path: "*", element: <Placeholder title="Not found" note="That page does not exist." /> },
    ],
  },
];
