import "./pf.css";

// Clean empty state for when the feed file is absent or unreadable —
// the pages must never crash on a missing feed.
export default function FeedMissing({
  title,
  reason,
}: {
  title: string;
  reason: "missing" | "malformed";
}) {
  return (
    <div className="pfviz">
      <div className="card feed-missing">
        <div className="big">🔌</div>
        <h1>{title}</h1>
        <p className="hint" style={{ maxWidth: "52ch", margin: "8px auto 0" }}>
          {reason === "malformed"
            ? "The finance feed was found but could not be parsed. The feed lane may be mid-deploy — check the exporter's output against the data contract."
            : "The finance feed is not wired up yet. Set PF_DATA_PATH to a local feed file (dev) or PF_GITHUB_TOKEN for the private data repo (prod), then reload."}
        </p>
      </div>
    </div>
  );
}
