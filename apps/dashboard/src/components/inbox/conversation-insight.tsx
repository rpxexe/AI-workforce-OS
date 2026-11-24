import { DETECTED_LANGUAGES, ENTITY_TYPES, HANDOFF_TRIGGER_LABELS, INTENTS, type ConversationInsight } from "@workforce/shared";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const SENTIMENT_LABELS = { positive: "Positive", negative: "Negative", neutral: "Neutral", mixed: "Mixed" } as const;
const RESOLUTION_LABELS = { resolved: "Resolved", with_people: "With people", open: "Open" } as const;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex flex-wrap items-center gap-1.5">{children}</dd>
    </>
  );
}

/** What the analyzers read from the customer's messages: language, sentiment, intent, entities, resolution, escalation. */
export function ConversationInsightCard({ insight }: { insight: ConversationInsight }) {
  const { escalation } = insight;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Conversation insights</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
          <Row label="Language">
            {insight.languages.length === 0
              ? "—"
              : insight.languages.map((l) => (
                  <Badge key={l.language} variant="secondary">
                    {DETECTED_LANGUAGES[l.language]} · {l.messages}
                  </Badge>
                ))}
          </Row>
          <Row label="Language switches">
            {insight.switches} · {insight.codeSwitchedMessages} mixed-language {insight.codeSwitchedMessages === 1 ? "message" : "messages"}
          </Row>
          <Row label="Sentiment">
            {SENTIMENT_LABELS[insight.sentiment]}
            {insight.sentimentIndicators.length > 0 && (
              <span className="text-muted-foreground">
                ({[...new Set(insight.sentimentIndicators.map((s) => `“${s.phrase}”`))].slice(0, 5).join(", ")})
              </span>
            )}
          </Row>
          <Row label="Intent">
            {INTENTS[insight.intent]}
            {insight.intents.length > 1 && <span className="text-muted-foreground">also {insight.intents.slice(1).map((i) => INTENTS[i]).join(", ")}</span>}
          </Row>
          <Row label="Resolution">
            {RESOLUTION_LABELS[insight.resolution]}
            {insight.resolutionSignals.length > 0 && <span className="text-muted-foreground">(“{insight.resolutionSignals.join("”, “")}”)</span>}
          </Row>
          <Row label="Escalation">
            {escalation.escalated
              ? `${escalation.handoffs} ${escalation.handoffs === 1 ? "handoff" : "handoffs"}: ${escalation.triggers.map((t) => HANDOFF_TRIGGER_LABELS[t]).join(", ")}`
              : "None"}
            {escalation.signals.length > 0 && <span className="text-muted-foreground">customer mentioned “{escalation.signals.join("”, “")}”</span>}
          </Row>
        </dl>
        <div className="flex flex-col gap-2">
          <h3 className="font-medium">Details mentioned</h3>
          {insight.entities.length === 0 ? (
            <p className="text-muted-foreground">No names, numbers, addresses, dates or amounts found.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {insight.entities.map((e) => (
                <li key={`${e.type}:${e.value}`} className="flex flex-wrap gap-x-2">
                  <span className="text-muted-foreground">{ENTITY_TYPES[e.type]}</span>
                  <span className="break-all">{e.value}</span>
                  {e.details?.currency && <span className="text-muted-foreground">{e.details.currency}</span>}
                  {e.value !== e.text && <span className="text-muted-foreground">(“{e.text}”)</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
