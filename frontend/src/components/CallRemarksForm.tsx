import { useEffect, useState } from "react";
import {
  CALL_OUTCOMES,
  NO_ANSWER_VOICE_OPTIONS,
  NOT_INTERESTED_REASON_OPTIONS,
  VOICEMAIL_REMARK_OPTIONS,
  applyNoAnswerVoiceToRemarks,
  applyNotInterestedReasonToRemarks,
  clearOutcomeTagsFromRemarks,
  parseNoAnswerVoiceFromRemarks,
  parseNotInterestedReasonFromRemarks,
  remarksHasVoicemailPreset,
  toggleVoicemailRemark,
  type CallOutcome,
  type NoAnswerVoiceOption,
  type NotInterestedReasonOption,
} from "../utils/callOutcomes";
import {
  autocorrectText,
  capitalizeFirstLetter,
  spellingInputProps,
} from "../utils/spelling";
import { ActionButton } from "./ui/ActionButton";
import { IconSave } from "./icons/AppIcons";

interface CallRemarksFormProps {
  remarks: string;
  outcome: CallOutcome | "";
  onRemarksChange: (value: string) => void;
  onOutcomeChange: (value: CallOutcome | "") => void;
  onSave: () => void;
  saving?: boolean;
  saveLabel?: string;
  compact?: boolean;
}

export function CallRemarksForm({
  remarks,
  outcome,
  onRemarksChange,
  onOutcomeChange,
  onSave,
  saving = false,
  saveLabel = "Save remarks",
  compact = false,
}: CallRemarksFormProps) {
  const [voiceDetail, setVoiceDetail] = useState<NoAnswerVoiceOption | "">(() =>
    parseNoAnswerVoiceFromRemarks(remarks),
  );
  const [notInterestedReason, setNotInterestedReason] = useState<
    NotInterestedReasonOption | ""
  >(() => parseNotInterestedReasonFromRemarks(remarks));

  useEffect(() => {
    setVoiceDetail(parseNoAnswerVoiceFromRemarks(remarks));
    setNotInterestedReason(parseNotInterestedReasonFromRemarks(remarks));
  }, [remarks, outcome]);

  function handleOutcomeChange(next: CallOutcome | "") {
    onOutcomeChange(next);

    let nextRemarks = remarks;
    if (outcome === "not_received_call" && next !== "not_received_call") {
      setVoiceDetail("");
      nextRemarks = clearOutcomeTagsFromRemarks(nextRemarks, "not_received_call");
    }
    if (outcome === "not_interested" && next !== "not_interested") {
      setNotInterestedReason("");
      nextRemarks = clearOutcomeTagsFromRemarks(nextRemarks, "not_interested");
    }
    if (nextRemarks !== remarks) onRemarksChange(nextRemarks);
  }

  function handleVoiceDetailChange(next: NoAnswerVoiceOption | "") {
    setVoiceDetail(next);
    onRemarksChange(applyNoAnswerVoiceToRemarks(remarks, next));
  }

  function handleNotInterestedReasonChange(next: NotInterestedReasonOption | "") {
    setNotInterestedReason(next);
    onRemarksChange(applyNotInterestedReasonToRemarks(remarks, next));
  }

  function handleVoicemailPreset(preset: string) {
    onRemarksChange(toggleVoicemailRemark(remarks, preset));
  }

  const showNoAnswerExtras = outcome === "not_received_call";
  const showNotInterestedExtras = outcome === "not_interested";

  return (
    <div className={`space-y-3 ${compact ? "" : "pt-1"}`}>
      <div className="space-y-2">
        <label className="text-xs text-slate-500">Call outcome</label>
        <select
          value={outcome}
          onChange={(e) => handleOutcomeChange(e.target.value as CallOutcome | "")}
          className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200"
        >
          <option value="">Select outcome…</option>
          {CALL_OUTCOMES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </div>

      {showNoAnswerExtras && (
        <div className="space-y-2">
          <label className="text-xs text-slate-500">Did not receive call — detail</label>
          <select
            value={voiceDetail}
            onChange={(e) =>
              handleVoiceDetailChange(e.target.value as NoAnswerVoiceOption | "")
            }
            className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200"
          >
            <option value="">Select…</option>
            {NO_ANSWER_VOICE_OPTIONS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {showNotInterestedExtras && (
        <div className="space-y-2">
          <label className="text-xs text-slate-500">Not interested — reason</label>
          <select
            value={notInterestedReason}
            onChange={(e) =>
              handleNotInterestedReasonChange(
                e.target.value as NotInterestedReasonOption | "",
              )
            }
            className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200"
          >
            <option value="">Select reason…</option>
            {NOT_INTERESTED_REASON_OPTIONS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="space-y-2">
        <label className="text-xs text-slate-500">Remarks</label>
        {showNoAnswerExtras && (
          <div className="flex flex-wrap gap-2">
            {VOICEMAIL_REMARK_OPTIONS.map((item) => {
              const active = remarksHasVoicemailPreset(remarks, item.value);
              return (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => handleVoicemailPreset(item.value)}
                  className={
                    active
                      ? "px-2.5 py-1 rounded-lg border border-amber-500/40 bg-amber-500/15 text-amber-200 text-xs"
                      : "px-2.5 py-1 rounded-lg border border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-900 text-xs"
                  }
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        )}
        <textarea
          value={remarks}
          onChange={(e) => onRemarksChange(capitalizeFirstLetter(e.target.value))}
          onBlur={(e) =>
            onRemarksChange(autocorrectText(e.target.value, "prose"))
          }
          rows={compact ? 4 : 5}
          placeholder={
            showNoAnswerExtras
              ? "Optional extra notes… or tap Voicemail / No voicemail above"
              : showNotInterestedExtras
                ? "Optional extra notes about why they declined…"
                : "Products discussed, follow-up date, objections, next steps…"
          }
          className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200"
          {...spellingInputProps("prose")}
        />
      </div>
      <ActionButton
        icon={IconSave}
        variant="primary"
        size="md"
        disabled={saving}
        onClick={onSave}
        title={saveLabel}
      >
        {saving ? "Saving…" : saveLabel}
      </ActionButton>
    </div>
  );
}
