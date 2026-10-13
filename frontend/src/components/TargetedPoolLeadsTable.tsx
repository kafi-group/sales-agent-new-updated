import type { ReactNode } from "react";
import { CountrySelect } from "./CountrySelect";
import { CallLeadButton } from "./CallLeadButton";
import { DialpadPhoneText } from "./DialpadPhoneText";
import { EmailLeadButton } from "./EmailLeadButton";
import { WhatsAppLeadButton } from "./WhatsAppLeadButton";
import { formatCountryLabel } from "../data/countries";
import type { LeadTableRow } from "../api/client";
import { spellingPropsForLeadField } from "../utils/spelling";

const TH = "py-3 px-3 text-left whitespace-nowrap align-middle";
const TD = "py-3 px-3 align-middle";
const TD_MUTED = `${TD} text-slate-400`;
const TD_PRIMARY = `${TD} text-slate-200 font-medium`;
const COL_SERIAL = "w-[65px] max-w-[65px] min-w-[65px]";
const COL_COMPANY = "w-[220px] max-w-[220px] min-w-[220px]";
const COL_EMAIL = "w-[180px] max-w-[180px] min-w-[180px]";
const COL_EMAIL2 = "w-[170px] max-w-[170px] min-w-[170px]";
const COL_FIXED = "whitespace-nowrap overflow-hidden text-ellipsis";
const EDIT_INPUT =
  "w-full min-w-0 rounded-md bg-slate-950 border border-slate-700 px-2 py-1 text-sm text-slate-200";

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export type TargetedPoolLeadsTableProps = {
  rows: LeadTableRow[];
  drafts: Record<number, LeadTableRow>;
  selected: Set<number>;
  editMode: boolean;
  theadStickyClass: string;
  isFullscreen: boolean;
  allOnPageSelected: boolean;
  someOnPageSelected: boolean;
  toggleSelectAllOnPage: () => void;
  toggleSelected: (id: number) => void;
  sortIndicator: (field: "company_name" | "country" | "created_at") => string;
  toggleSort: (field: "company_name" | "country" | "created_at") => void;
  onSelectLead: (id: number) => void;
  onError: (message: string) => void;
  deletingId: number | null;
  deletingSelected: boolean;
  deleteRows: (ids: number[]) => void | Promise<void>;
  updateDraft: (id: number, field: keyof LeadTableRow, value: string) => void;
  commitDraftField: (id: number, field: keyof LeadTableRow, value: string) => void;
  openWhatsAppCompose: (row: LeadTableRow, phone: string) => void;
};

export function TargetedPoolLeadsTable({
  rows,
  drafts,
  selected,
  editMode,
  theadStickyClass,
  isFullscreen,
  allOnPageSelected,
  someOnPageSelected,
  toggleSelectAllOnPage,
  toggleSelected,
  sortIndicator,
  toggleSort,
  onSelectLead,
  onError,
  deletingId,
  deletingSelected,
  deleteRows,
  updateDraft,
  commitDraftField,
  openWhatsAppCompose,
}: TargetedPoolLeadsTableProps) {
  return (
    <table className="w-full text-sm border-collapse min-w-[2400px]">
      <thead>
        <tr className={`text-slate-500 border-b border-slate-800 bg-slate-950 ${theadStickyClass}`}>
          <th
            data-col="select"
            className={`${TH} w-12 sticky left-0 bg-slate-950 z-[1] ${isFullscreen ? "top-0 z-[3]" : ""}`}
          >
            <input
              type="checkbox"
              checked={allOnPageSelected}
              ref={(el) => {
                if (el) el.indeterminate = someOnPageSelected && !allOnPageSelected;
              }}
              onChange={toggleSelectAllOnPage}
              aria-label="Select all leads on this page"
              className="rounded border-slate-600 bg-slate-950"
            />
          </th>
          <th data-col="serial" className={`${TH} ${COL_SERIAL}`}>
            S. No.
          </th>
          <th data-col="company" className={`${TH} ${COL_COMPANY}`}>
            <button type="button" onClick={() => toggleSort("company_name")} className="hover:text-slate-300">
              Company Name{sortIndicator("company_name")}
            </button>
          </th>
          <th data-col="business_type" className={`${TH} min-w-[140px]`}>
            Business Type
          </th>
          <th data-col="designation" className={`${TH} min-w-[130px]`}>
            Designation
          </th>
          <th data-col="contact_person" className={`${TH} min-w-[150px]`}>
            Contact Person
          </th>
          <th data-col="primary_mobile" className={`${TH} min-w-[160px]`}>
            Primary Mobile No.
          </th>
          <th data-col="secondary_mobile" className={`${TH} min-w-[160px]`}>
            Secondary Mobile No.
          </th>
          <th data-col="primary_phone" className={`${TH} min-w-[160px]`}>
            Primary Phone No.
          </th>
          <th data-col="secondary_phone" className={`${TH} min-w-[160px]`}>
            Secondary Phone No.
          </th>
          <th data-col="primary_email" className={`${TH} ${COL_EMAIL}`}>
            Primary Email
          </th>
          <th data-col="secondary_email" className={`${TH} ${COL_EMAIL2}`}>
            Secondary Email
          </th>
          <th data-col="country" className={`${TH} min-w-[130px]`}>
            <button type="button" onClick={() => toggleSort("country")} className="hover:text-slate-300">
              Country{sortIndicator("country")}
            </button>
          </th>
          <th data-col="product" className={`${TH} min-w-[140px]`}>
            Product
          </th>
          <th data-col="city" className={`${TH} min-w-[120px]`}>
            City
          </th>
          <th data-col="address" className={`${TH} min-w-[200px]`}>
            Address
          </th>
          <th data-col="grading" className={`${TH} min-w-[120px]`}>
            Grading
          </th>
          <th data-col="remarks" className={`${TH} min-w-[160px]`}>
            Remarks 02
          </th>
          <th data-col="remarks_03" className={`${TH} min-w-[160px]`}>
            Remarks 03
          </th>
          <th data-col="date" className={`${TH} min-w-[120px]`}>
            <button type="button" onClick={() => toggleSort("created_at")} className="hover:text-slate-300">
              Date{sortIndicator("created_at")}
            </button>
          </th>
          <th data-col="actions" className={`${TH} min-w-[100px]`}>
            Actions
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const draft = drafts[row.id] ?? row;
          const cell = (
            field: keyof LeadTableRow,
            display: string,
            opts?: { type?: string; className?: string },
          ): ReactNode =>
            editMode ? (
              <input
                type={opts?.type ?? "text"}
                value={
                  field === "legacy_serial_no"
                    ? draft.legacy_serial_no != null
                      ? String(draft.legacy_serial_no)
                      : ""
                    : String((draft[field] as string | null | undefined) ?? "")
                }
                onChange={(e) => updateDraft(row.id, field, e.target.value)}
                onBlur={(e) => commitDraftField(row.id, field, e.target.value)}
                onClick={(e) => e.stopPropagation()}
                className={`${EDIT_INPUT} ${opts?.className ?? ""}`}
                {...spellingPropsForLeadField(String(field))}
              />
            ) : (
              <span className={`block truncate ${opts?.className ?? ""}`}>{display || "—"}</span>
            );

          const emailCell = (
            email: string | null | undefined,
            field: keyof LeadTableRow,
          ) =>
            editMode ? (
              cell(field, email ?? "", { type: "email" })
            ) : email?.includes("@") ? (
              <span className="flex items-center gap-2 min-w-0">
                <span className="truncate block" title={email}>
                  {email}
                </span>
                <EmailLeadButton email={email} row={row} onError={onError} compact />
              </span>
            ) : (
              "—"
            );

          const phoneCell = (
            phone: string | null | undefined,
            field: keyof LeadTableRow,
          ) =>
            editMode ? (
              cell(field, phone ?? "")
            ) : phone ? (
              <span className="flex items-center gap-2 min-w-0">
                <DialpadPhoneText phone={phone} contactName={row.contact_name} countryHint={row.country} />
                <CallLeadButton leadId={row.id} phone={phone} onError={onError} compact />
                <WhatsAppLeadButton phone={phone} compact onClick={() => openWhatsAppCompose(row, phone)} />
              </span>
            ) : (
              "—"
            );

          return (
            <tr
              key={row.id}
              data-ai-hl={
                ((row.ai_data_update_fields as string[] | null | undefined) ?? [])
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              onClick={() => {
                if (!editMode) onSelectLead(row.id);
              }}
              className={`border-b border-slate-800/60 ${
                editMode ? "" : "cursor-pointer hover:bg-slate-900/80"
              } ${selected.has(row.id) ? "bg-slate-900/40" : ""}`}
            >
              <td
                data-col="select"
                className={`${TD} sticky left-0 bg-slate-900 z-[1]`}
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  checked={selected.has(row.id)}
                  onChange={() => toggleSelected(row.id)}
                  aria-label={`Select ${row.company_name}`}
                  className="rounded border-slate-600 bg-slate-950"
                />
              </td>
              <td data-col="serial" className={`${TD_MUTED} ${COL_SERIAL} ${COL_FIXED}`}>
                {editMode ? (
                  cell("legacy_serial_no", row.legacy_serial_no != null ? String(row.legacy_serial_no) : "")
                ) : (
                  <span className="truncate block" title={row.legacy_serial_no != null ? String(row.legacy_serial_no) : undefined}>
                    {row.legacy_serial_no != null ? String(row.legacy_serial_no) : "—"}
                  </span>
                )}
              </td>
              <td data-col="company" className={`${TD_PRIMARY} ${COL_COMPANY} ${COL_FIXED}`}>
                {editMode ? (
                  cell("company_name", row.company_name)
                ) : (
                  <span className="truncate block text-slate-200 font-medium" title={row.company_name}>
                    {row.company_name || "—"}
                  </span>
                )}
              </td>
              <td data-col="business_type" className={TD_MUTED}>
                {cell("industry", row.industry ?? "")}
              </td>
              <td data-col="designation" className={TD_MUTED}>
                {cell("contact_designation", row.contact_designation ?? "")}
              </td>
              <td data-col="contact_person" className={TD_MUTED}>
                {cell("contact_name", row.contact_name ?? "")}
              </td>
              <td data-col="primary_mobile" className={TD_MUTED}>
                {phoneCell(row.contact_phone, "contact_phone")}
              </td>
              <td data-col="secondary_mobile" className={TD_MUTED}>
                {phoneCell(row.contact_secondary_mobile, "contact_secondary_mobile")}
              </td>
              <td data-col="primary_phone" className={TD_MUTED}>
                {phoneCell(row.contact_primary_phone, "contact_primary_phone")}
              </td>
              <td data-col="secondary_phone" className={TD_MUTED}>
                {phoneCell(row.contact_secondary_phone, "contact_secondary_phone")}
              </td>
              <td
                data-col="primary_email"
                className={`${TD_MUTED} ${COL_EMAIL} ${COL_FIXED}`}
                onClick={(e) => e.stopPropagation()}
              >
                {emailCell(row.contact_email, "contact_email")}
              </td>
              <td data-col="secondary_email" className={`${TD_MUTED} ${COL_EMAIL2} ${COL_FIXED}`}>
                {emailCell(row.contact_secondary_email, "contact_secondary_email")}
              </td>
              <td data-col="country" className={TD_MUTED}>
                {editMode ? (
                  <div onClick={(e) => e.stopPropagation()}>
                    <CountrySelect
                      value={draft.country ?? ""}
                      onChange={(value) => updateDraft(row.id, "country", value)}
                    />
                  </div>
                ) : (
                  <span className="truncate block">{formatCountryLabel(row.country)}</span>
                )}
              </td>
              <td data-col="product" className={TD_MUTED}>
                {cell("product_interest", row.product_interest ?? "")}
              </td>
              <td data-col="city" className={TD_MUTED}>
                {cell("city", row.city ?? "")}
              </td>
              <td data-col="address" className={TD_MUTED}>
                {cell("address", row.address ?? "")}
              </td>
              <td data-col="grading" className={TD_MUTED}>
                {cell("company_grading", row.company_grading ?? "")}
              </td>
              <td data-col="remarks" className={TD_MUTED}>
                {editMode ? cell("remarks", row.remarks ?? "") : (
                  <span className="truncate block" title={row.remarks ?? undefined}>
                    {row.remarks || "—"}
                  </span>
                )}
              </td>
              <td data-col="remarks_03" className={TD_MUTED}>
                {editMode ? cell("remarks_03", row.remarks_03 ?? "") : (
                  <span className="truncate block" title={row.remarks_03 ?? undefined}>
                    {row.remarks_03 || "—"}
                  </span>
                )}
              </td>
              <td data-col="date" className={TD_MUTED} title={row.created_at || undefined}>
                {formatDate(row.created_at)}
              </td>
              <td data-col="actions" className={`${TD} whitespace-nowrap`}>
                <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    onClick={() => void deleteRows([row.id])}
                    disabled={deletingId === row.id || deletingSelected}
                    className="px-2 py-1 rounded bg-red-900/50 hover:bg-red-800 border border-red-800/50 text-xs text-red-200 disabled:opacity-50"
                  >
                    {deletingId === row.id ? "Deleting…" : "Delete"}
                  </button>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
