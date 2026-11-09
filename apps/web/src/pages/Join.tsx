import { useNavigate, useParams } from "react-router";
import { useApi } from "../api";
import { useAuth } from "../auth";
import { EmailCodeSignIn } from "../components/EmailCodeSignIn";
import { TeamNameForm } from "../components/TeamNameForm";
import { Card, ErrorWithRetry, Loading } from "../components/ui";
import { INVITE_INVALID_TEXT, friendlyError } from "../lib/messages";
import { useLeague } from "../league/LeagueProvider";
import { useQuery } from "../useQuery";

export function Join() {
  const { token = "" } = useParams();
  const api = useApi();
  const auth = useAuth();
  const league = useLeague();
  const navigate = useNavigate();
  const preview = useQuery(`invite:${token}`, () => api.previewInvite(token));

  if (preview.status === "loading" || auth.status === "loading") return <Loading />;
  if (preview.status === "error")
    return <ErrorWithRetry message={friendlyError(preview.error)} onRetry={preview.reload} />;

  const invite = preview.data;
  if (!invite.valid) {
    return (
      <section className="space-y-2">
        <h2 className="text-xl font-semibold">Invite unavailable</h2>
        <p role="alert" className="text-muted">
          {INVITE_INVALID_TEXT[invite.reason ?? "not_found"]}
        </p>
      </section>
    );
  }

  const title = `Join ${invite.leagueName ?? "the league"}${invite.seasonYear ? ` ${invite.seasonYear}` : ""}`;

  return (
    <section className="mx-auto max-w-sm space-y-4">
      <h2 className="text-xl font-semibold">{title}</h2>
      {invite.pendingEmail && (
        <p className="text-sm text-muted">
          This invite is reserved for {invite.pendingEmail}. Use that email to continue.
        </p>
      )}
      {auth.status === "signedIn" ? (
        <Card>
          <p className="mb-3 text-sm text-muted">
            Signed in as <strong>{auth.email}</strong>. Pick a name for your team.
          </p>
          <TeamNameForm
            submitLabel="Join league"
            onSubmit={async (teamName) => {
              await api.acceptInvite(token, teamName);
              league.reload();
              await navigate("/");
            }}
          />
        </Card>
      ) : (
        <Card>
          <p className="mb-3 text-sm text-muted">
            Enter your email to join. {auth.mode === "cognito" && "We will email you a code."}
          </p>
          <EmailCodeSignIn beforeSend={async (email) => void (await api.register(token, email))} />
        </Card>
      )}
    </section>
  );
}
