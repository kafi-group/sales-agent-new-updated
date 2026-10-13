import { useEffect } from "react";
import type { IndexAction, IndexSection } from "../data/indexSections";
import { visibleIndexSections, type AssigneeIndexInput } from "../data/indexSections";
import { IndexIcon, IndexSectionIcon, IconList } from "../components/icons/AppIcons";

interface IndexesPageProps {
  isAdmin: boolean;
  quotationAgentUrl: string;
  assignees?: AssigneeIndexInput[];
  hideOutcomeBuckets?: boolean;
  onNavigate: (action: IndexAction) => void;
}

function resolveAction(
  action: IndexAction,
  quotationAgentUrl: string,
): IndexAction {
  if (action.type === "external" && action.url === "__QUOTATION_AGENT__") {
    return { type: "external", url: quotationAgentUrl };
  }
  return action;
}

function IndexSectionCard({
  section,
  quotationAgentUrl,
  onNavigate,
}: {
  section: IndexSection;
  quotationAgentUrl: string;
  isAdmin: boolean;
  onNavigate: (action: IndexAction) => void;
}) {
  const openAction = resolveAction(section.openAction, quotationAgentUrl);

  return (
    <section
      id={`index-section-${section.number}`}
      className="rounded-2xl border border-slate-800 bg-slate-900/50 overflow-hidden"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 px-5 py-4">
        <div className="min-w-0 flex-1 flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/10 border border-emerald-500/20 shrink-0">
            <IndexSectionIcon sectionNumber={section.number} size="sm" />
          </span>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-slate-100">
              <span className="text-emerald-400">{section.number}.</span>{" "}
              {section.title}
            </h2>
            <p className="mt-1 text-sm text-slate-500 leading-relaxed">
              {section.description}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onNavigate(openAction)}
          className="shrink-0 rounded-lg bg-emerald-700 hover:bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition"
        >
          Open section
        </button>
      </div>

      <ul className="divide-y divide-slate-800/80">
        {section.items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() =>
                onNavigate(resolveAction(item.action, quotationAgentUrl))
              }
              className="w-full flex items-start gap-4 px-5 py-4 text-left hover:bg-slate-800/40 transition"
            >
              <span className="shrink-0 pt-0.5 text-sm font-semibold text-emerald-400/90 w-8">
                {item.id}
              </span>
              <span className="shrink-0 pt-0.5">
                <IndexIcon name={item.icon} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-slate-100">
                  {item.title}
                </span>
                <span className="block mt-0.5 text-sm text-slate-500 leading-relaxed">
                  {item.description}
                </span>
              </span>
              <span className="shrink-0 text-slate-600 text-xs pt-1">→</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function IndexesPage({
  isAdmin,
  quotationAgentUrl,
  assignees = [],
  hideOutcomeBuckets = false,
  onNavigate,
}: IndexesPageProps) {
  const sections = visibleIndexSections(isAdmin, assignees, { hideOutcomeBuckets });

  useEffect(() => {
    const raw = sessionStorage.getItem("kafi.indexSection");
    if (!raw) return;
    sessionStorage.removeItem("kafi.indexSection");
    const id = Number(raw);
    if (!Number.isFinite(id)) return;
    window.requestAnimationFrame(() => {
      document
        .getElementById(`index-section-${id}`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, []);

  return (
    <div className="space-y-8 w-full min-w-0">
      <header className="space-y-2">
        <p className="text-xs uppercase tracking-wider text-emerald-400/80 font-medium flex items-center gap-2">
          <IconList size="xs" />
          Navigation index
        </p>
        <h1 className="text-2xl sm:text-3xl font-semibold text-slate-100 tracking-tight">
          Indexes
        </h1>
        <p className="text-sm text-slate-500 max-w-2xl leading-relaxed">
          Quick map of every sidebar area — same order as the menu: WhatsApp,
          Discover Leads & Master table, Mail, Vercel mailer, Calls, and the
          rest. Click a row or{" "}
          <span className="text-slate-400">Open section</span> to jump there.
        </p>
      </header>

      <div className="space-y-6">
        {sections.map((section) => (
          <IndexSectionCard
            key={section.number}
            section={section}
            quotationAgentUrl={quotationAgentUrl}
            isAdmin={isAdmin}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </div>
  );
}
