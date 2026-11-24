import type { RouteObject } from "react-router";
import { Layout } from "./components/Layout";
import { RequireAuth } from "./components/RequireAuth";
import { DraftRoom } from "./draft/DraftRoom";
import { Commissioner } from "./pages/Commissioner";
import { LeagueHome } from "./pages/LeagueHome";
import { Placeholder } from "./pages/Placeholder";
import { OverridesPage } from "./scoring/OverridesPage";
import { RulesPage } from "./scoring/RulesView";
import { StandingsPage } from "./scoring/StandingsPage";
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
            element: <StandingsPage />,
          },
          {
            path: "my-team",
            element: <Placeholder title="My team" note="Your locked roster (task 11)." />,
          },
          {
            path: "rules",
            element: <RulesPage />,
          },
          { path: "commissioner", element: <Commissioner /> },
          { path: "commissioner/overrides", element: <OverridesPage /> },
        ],
      },
      { path: "*", element: <Placeholder title="Not found" note="That page does not exist." /> },
    ],
  },
];
