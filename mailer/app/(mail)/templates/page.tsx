"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import {
  EmailBodyEditor,
  emailBodyHasContent,
  type EmailBodyEditorHandle,
} from "@/components/EmailBodyEditor";
import { PictureDropdownPicker } from "@/components/PictureDropdownPicker";

type Template = {
  id: number;
  name: string;
  subject: string;
  body: string;
};

export default function TemplatesPage() {
  const [rows, setRows] = useState<Template[]>([]);
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const bodyEditorRef = useRef<EmailBodyEditorHandle>(null);

  const load = useCallback(async () => {
    try {
      setRows(await apiFetch<Template[]>("/email-templates"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load templates");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setError(null);
    try {
      await apiFetch("/email-templates", {
        method: "POST",
        body: JSON.stringify({ name, subject, body, attachments: [] }),
      });
      setName("");
      setSubject("");
      setBody("");
      setNotice("Template saved");
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function remove(id: number) {
    await apiFetch(`/email-templates/${id}`, { method: "DELETE" });
    void load();
  }

  return (
    <div>
        <h2 className="folder-title">Email templates</h2>
        {error && <p className="bad">{error}</p>}
        {notice && <p className="ok">{notice}</p>}
        <div className="card" style={{ marginBottom: "1.25rem" }}>
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <label>Subject</label>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "1rem", marginBottom: "0.4rem" }}>
            <label style={{ margin: 0 }}>Body</label>
            <PictureDropdownPicker
              onInsert={(url, filename) => bodyEditorRef.current?.insertPicture(url, filename)}
            />
          </div>
          <EmailBodyEditor ref={bodyEditorRef} value={body} onChange={setBody} rows={6} />
          <button
            type="button"
            className="btn"
            disabled={!name.trim() || !subject.trim() || !emailBodyHasContent(body)}
            onClick={() => void create()}
          >
            Save template
          </button>
        </div>
        <ul className="simple-list">
          {rows.map((t) => (
            <li key={t.id} className="card-row">
              <div>
                <p className="msg-subject">{t.name}</p>
                <p className="muted small">{t.subject}</p>
              </div>
              <button type="button" className="btn ghost" onClick={() => void remove(t.id)}>
                Delete
              </button>
            </li>
          ))}
          {rows.length === 0 && <li className="muted">No templates</li>}
        </ul>
    </div>
  );
}
