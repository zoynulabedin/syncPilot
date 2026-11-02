import { Gid, Table } from "./ui";

export type PreviewChange = {
  kind: string;
  sourceId?: string;
  targetId?: string;
  field?: string;
  before?: unknown;
  after?: unknown;
  sourceLocationId?: string;
  targetLocationId?: string;
  code?: string;
  message?: string;
};
export function readChanges(value: unknown): PreviewChange[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is PreviewChange =>
    Boolean(item && typeof item === "object" && "kind" in item),
  );
}
function display(value: unknown) {
  return value === undefined || value === null
    ? "—"
    : typeof value === "string"
      ? value
      : JSON.stringify(value);
}
export function Changes({ value }: { value: unknown }) {
  const changes = readChanges(value);
  if (!changes.length)
    return <p className="sp-muted">No changes found in this comparison.</p>;
  return (
    <Table
      headings={[
        "Type / field",
        "Source → destination",
        "Current value",
        "Proposed value",
        "Review",
      ]}
    >
      {changes.map((change, index) => (
        <tr key={`${change.kind}-${change.sourceId}-${change.field}-${index}`}>
          <td>
            <strong>{change.kind}</strong>
            <div className="sp-muted">{change.field}</div>
          </td>
          <td>
            <Gid value={change.sourceId} /> → <Gid value={change.targetId} />
            {change.targetLocationId && (
              <div className="sp-muted">
                Location <Gid value={change.targetLocationId} />
              </div>
            )}
          </td>
          <td>
            <div
              style={{
                maxWidth: 220,
                maxHeight: 100,
                overflow: "auto",
                overflowWrap: "anywhere",
              }}
            >
              {display(change.before)}
            </div>
          </td>
          <td>
            <div
              style={{
                maxWidth: 220,
                maxHeight: 100,
                overflow: "auto",
                overflowWrap: "anywhere",
              }}
            >
              {display(change.after)}
            </div>
          </td>
          <td className={change.kind === "HOLD" ? "sp-risk" : ""}>
            {change.code ||
              (change.kind === "HOLD" ? "Held for review" : "Proposed change")}
            <div className="sp-muted">{change.message}</div>
          </td>
        </tr>
      ))}
    </Table>
  );
}
