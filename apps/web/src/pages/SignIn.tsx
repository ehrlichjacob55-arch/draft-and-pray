import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useAuth } from "../auth";
import { EmailCodeSignIn } from "../components/EmailCodeSignIn";
import { Card, Loading } from "../components/ui";
import { safeNext } from "../lib/messages";

export function SignIn() {
  const { status } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(params.get("next"));

  useEffect(() => {
    if (status === "signedIn") void navigate(next, { replace: true });
  }, [status, next, navigate]);

  if (status === "loading" || status === "signedIn") return <Loading />;

  return (
    <section className="mx-auto max-w-sm space-y-4">
      <h2 className="text-xl font-semibold">Sign in</h2>
      <Card>
        <EmailCodeSignIn />
      </Card>
      <p className="text-sm text-muted">
        New here? Your commissioner adds you and emails you a link — there is no public sign-up.
      </p>
    </section>
  );
}
