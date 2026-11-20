import { LANGUAGES, type EmployeeConfig } from "@workforce/shared";
import { diffLines } from "@/lib/diff";
import { cn } from "@/lib/utils";

const FIELDS: { key: keyof EmployeeConfig; label: string }[] = [
  { key: "systemInstructions", label: "System instructions" },
  { key: "personality", label: "Personality" },
  { key: "goals", label: "Goals" },
  { key: "name", label: "Name" },
  { key: "role", label: "Role" },
  { key: "description", label: "Description" },
  { key: "language", label: "Language" },
  { key: "avatar", label: "Avatar" },
  { key: "workingHours", label: "Working hours" },
  { key: "escalation", label: "Escalation" },
];

/** A field as lines of text: lists one item per line, settings as indented JSON. */
function asText(config: EmployeeConfig, key: keyof EmployeeConfig) {
  const value = config[key];
  if (key === "language") return LANGUAGES[config.language];
  if (key === "goals") return config.goals.join("\n");
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

const MARK = { same: " ", added: "+", removed: "−" } as const;
const WORD = { same: "", added: "Added: ", removed: "Removed: " } as const;

/** What differs between two configurations, field by field, line by line. Lines carry + and − as well as colour. */
export function ConfigDiff({ before, after }: { before: EmployeeConfig; after: EmployeeConfig }) {
  const changed = FIELDS.filter(({ key }) => asText(before, key) !== asText(after, key));
  if (changed.length === 0) return <p className="text-sm text-muted-foreground">No differences: the two configurations are the same.</p>;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {changed.length} {changed.length === 1 ? "field differs" : "fields differ"}. Unchanged fields are not shown.
      </p>
      {changed.map(({ key, label }) => (
        <section key={key} className="flex flex-col gap-1.5">
          <h3 className="text-sm font-medium">{label}</h3>
          <pre className="max-h-96 overflow-auto rounded-md border font-mono text-xs leading-relaxed">
            {diffLines(asText(before, key), asText(after, key)).map((line, i) => (
              <div
                key={i}
                className={cn(
                  "flex gap-2 px-2 whitespace-pre-wrap",
                  line.kind === "added" && "bg-emerald-500/10 text-emerald-900 dark:text-emerald-200",
                  line.kind === "removed" && "bg-destructive/10 text-red-900 line-through decoration-red-900/40 dark:text-red-200",
                )}
              >
                <span className="select-none text-muted-foreground" aria-hidden>
                  {MARK[line.kind]}
                </span>
                <span>
                  <span className="sr-only">{WORD[line.kind]}</span>
                  {line.text || " "}
                </span>
              </div>
            ))}
          </pre>
        </section>
      ))}
    </div>
  );
}
