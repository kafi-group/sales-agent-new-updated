import type { IndexAction, IndexSection } from "../data/indexSections";
import { visibleIndexSections, type AssigneeIndexInput } from "../data/indexSections";
import {
  guideForIndexItem,
  SECTION_MANUAL_OVERVIEWS,
  type UserManualGuide,
} from "../data/userManualGuides";
import { IndexIcon, IndexSectionIcon, IconBook } from "../components/icons/AppIcons";

interface UserManualPageProps {
  isAdmin: boolean;
  quotationAgentUrl: string;
  assignees?: AssigneeIndexInput[];
  hideOutcomeBuckets?: boolean;
  onNavigate: (action: IndexAction) => void;
  onOpenIndexesSection: (sectionNumber: number) => void;
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

function ManualGuideBlock({ guide }: { guide: UserManualGuide }) {
  return (
    <div className="mt-3 space-y-3 text-sm">
      <p className="text-slate-400 leading-relaxed">{guide.overview}</p>
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-2">
          Who can use this
        </p>
        <p className="text-slate-300">{guide.whoFor}</p>
      </div>
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-2">
          Step-by-step
        </p>
        <ol className="list-decimal list-inside space-y-1.5 text-slate-300 leading-relaxed">
          {guide.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </div>
      {guide.tips && guide.tips.length > 0 && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2.5">
          <p className="text-xs font-medium text-amber-200/90 mb-1.5">Tips</p>
          <ul className="list-disc list-inside space-y-1 text-slate-400 text-sm">
            {guide.tips.map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ManualSectionCard({
  section,
  quotationAgentUrl,
  onNavigate,
  onOpenIndexesSection,
}: {
  section: IndexSection;
  quotationAgentUrl: string;
  isAdmin: boolean;
  onNavigate: (action: IndexAction) => void;
  onOpenIndexesSection: (sectionNumber: number) => void;
}) {
  const sectionOverview = SECTION_MANUAL_OVERVIEWS[section.number];

  return (
    <section
      id={`manual-section-${section.number}`}
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
              {sectionOverview || section.description}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 shrink-0">
          <button
            type="button"
            onClick={() => onOpenIndexesSection(section.number)}
            className="rounded-lg border border-slate-700 hover:bg-slate-800 px-4 py-2 text-sm text-slate-300 transition"
          >
            View in Indexes
          </button>
          <button
            type="button"
            onClick={() =>
              onNavigate(
                resolveAction(section.openAction, quotationAgentUrl),
              )
            }
            className="rounded-lg bg-emerald-700 hover:bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition"
          >
            Try it
          </button>
        </div>
      </div>

      <ul className="divide-y divide-slate-800/80">
        {section.items.map((item) => {
          const guide = guideForIndexItem(item.id);
          return (
            <li key={item.id} className="px-5 py-4">
              <div className="flex items-start gap-4">
                <span className="shrink-0 pt-0.5 text-sm font-semibold text-emerald-400/90 w-8">
                  {item.id}
                </span>
                <span className="shrink-0 pt-0.5">
                  <IndexIcon name={item.icon} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h3 className="text-sm font-medium text-slate-100">
                      {item.title}
                    </h3>
                    <button
                      type="button"
                      onClick={() =>
                        onNavigate(
                          resolveAction(item.action, quotationAgentUrl),
                        )
                      }
                      className="shrink-0 text-xs text-emerald-400 hover:text-emerald-300"
                    >
                      Open in app →
                    </button>
                  </div>
                  <p className="mt-0.5 text-sm text-slate-500">{item.description}</p>
                  {guide ? (
                    <ManualGuideBlock guide={guide} />
                  ) : (
                    <p className="mt-3 text-sm text-slate-500 italic">
                      Guide coming soon — use Indexes to navigate here.
                    </p>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function UserManualPage({
  isAdmin,
  quotationAgentUrl,
  assignees = [],
  hideOutcomeBuckets = false,
  onNavigate,
  onOpenIndexesSection,
}: UserManualPageProps) {
  const sections = visibleIndexSections(isAdmin, assignees, { hideOutcomeBuckets });

  return (
    <div className="space-y-8 w-full min-w-0">
      <header className="space-y-2">
        <p className="text-xs uppercase tracking-wider text-emerald-400/80 font-medium flex items-center gap-2">
          <IconBook size="xs" />
          Documentation
        </p>
        <h1 className="text-2xl sm:text-3xl font-semibold text-slate-100 tracking-tight">
          User Manual
        </h1>
        <p className="text-sm text-slate-500 max-w-2xl leading-relaxed">
          Guides follow the same order as{" "}
          <span className="text-slate-400">Indexes</span> and the sidebar —
          WhatsApp first, then Master table buckets, Mail folders, and down to
          Users. Use <span className="text-slate-400">Try it</span> to open
          each feature.
        </p>
      </header>

      <nav className="rounded-xl border border-slate-800 bg-slate-900/30 px-4 py-3">
        <p className="text-xs font-medium text-slate-500 mb-2">Jump to section</p>
        <div className="flex flex-wrap gap-2">
          {sections.map((section) => (
            <a
              key={section.number}
              href={`#manual-section-${section.number}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700/80 hover:border-emerald-500/40 hover:bg-slate-800/60 px-3 py-1.5 text-xs text-slate-300 transition"
            >
              <IndexSectionIcon sectionNumber={section.number} size="xs" />
              {section.number}. {section.title}
            </a>
          ))}
        </div>
      </nav>

      <div className="space-y-6">
        {sections.map((section) => (
          <ManualSectionCard
            key={section.number}
            section={section}
            quotationAgentUrl={quotationAgentUrl}
            isAdmin={isAdmin}
            onNavigate={onNavigate}
            onOpenIndexesSection={onOpenIndexesSection}
          />
        ))}
      </div>
    </div>
  );
}
