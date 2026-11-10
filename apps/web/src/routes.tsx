import type { RouteObject } from "react-router";
import { Layout } from "./components/Layout";
import { RequireAuth } from "./components/RequireAuth";
import { DraftRoom } from "./draft/DraftRoom";
import { Commissioner } from "./pages/Commissioner";
import { LeagueHome } from "./pages/LeagueHome";
import { Placeholder } from "./pages/Placeholder";
import { SignIn } from "./pages/SignIn";
import { Welcome } from "./pages/Welcome";

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <Layout />,
    children: [
      { path: "signin", element: <SignIn /> },
      { path: "welcome", element: <Welcome /> },
      {
        element: <RequireAuth />,
        children: [
          { index: true, element: <LeagueHome /> },
          {
            path: "draft",
            element: <DraftRoom />,
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
          { path: "commissioner", element: <Commissioner /> },
        ],
      },
      { path: "*", element: <Placeholder title="Not found" note="That page does not exist." /> },
    ],
  },
];
