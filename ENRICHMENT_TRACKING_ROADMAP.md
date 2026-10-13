# Master Data Enrichment & Tracking Roadmap

This tracking document records the status, progress, and upcoming consolidation phases for the **4,373 Master Data Contacts** across Usman and Asim's enrichment workflows.

---

## 📊 Master Data Breakdown Summary

| Bucket | Assignee | Target Pool | File 1 (Original Submitted) | File 2 (Missing Returned to Rep) | Current Status |
| :--- | :--- | :---: | :--- | :--- | :--- |
| **Graded Contacts** | **Usman** | **795** | `Gradings Contacts Searched by AI.xlsx` (709 rows) | `Usman_85_Missing_Contacts_To_Enrich.xlsx` (127 rows) | **Usman enriching 127 missing** |
| **Salt Products** | **Asim** | **1,411** | `salt file from asim.xlsx` (1,377 rows) | `Asim_Missing_Salt_Contacts_To_Enrich.xlsx` (135 rows) | **Asim enriching 135 missing** |
| **Remaining Pool** | **Usman & Asim** | **2,167** | Pending combined file submission | — | **Working simultaneously** |
| **TOTAL MASTER DATA** | — | **4,373** | — | — | **Target for 100% Master Consolidation** |

---

## 📂 Active File Tracking (2 Files Each + 1 Combined)

### 1. Usman's Graded Files (795 Target Pool)
- **File 1 (Original)**: `C:\Users\Abc\Downloads\795 given by usman\Gradings Contacts Searched by AI.xlsx` (709 rows / 668 matched)
- **File 2 (Missing)**: `C:\Users\Abc\Downloads\795 given by usman\Usman_85_Missing_Contacts_To_Enrich.xlsx` (127 contacts)

### 2. Asim's Salt Files (1,411 Target Pool)
- **File 1 (Original)**: `C:\Users\Abc\Downloads\salt from asim\salt file from asim.xlsx` (1,377 rows / 1,276 matched)
- **File 2 (Missing)**: `C:\Users\Abc\Downloads\salt from asim\Asim_Missing_Salt_Contacts_To_Enrich.xlsx` (135 contacts)

### 3. Remaining Pool Combined File (2,167 Target Pool)
- Non-graded, non-salt remaining pool currently being enriched by Usman & Asim simultaneously.
- Will be submitted as a **single consolidated file**.

---

## 🗓️ Master Consolidation Workflow

1. **Step 1 — Remaining 2,167 Pool Audit**:
   - As soon as the single 2,167 file is received, we will run the exact same missing diff algorithm against the remaining 2,167 DB contacts to find any missed contacts and return them for completion.

2. **Step 2 — Master File Merging**:
   - Merge all files (Usman Graded 1 + 2, Asim Salt 1 + 2, Remaining Pool 1 + 2) into 1 unified master enrichment dataset.

3. **Step 3 — Smart Data Clean & Merge Execution**:
   - Run through **🧩 Smart Data Clean & Merge — Read-Only Comparison Report**.
   - Review column-wise field fill rates and missing values before touching DB records.
   - Safely perform DB update (filling missing/null fields only while keeping existing data intact).

---
*Last Updated: 2026-08-29*
