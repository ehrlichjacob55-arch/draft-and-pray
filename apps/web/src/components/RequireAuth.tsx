import { Navigate, Outlet, useLocation } from "react-router";
import { useAuth } from "../auth";
import { Loading } from "./ui";

/** Redirects signed-out visitors to /signin?next=… (docs/design/11 §3.1). */
export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();
  if (status === "loading") return <Loading />;
  if (status === "signedOut") {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/signin?next=${next}`} replace />;
  }
  return <Outlet />;
}
