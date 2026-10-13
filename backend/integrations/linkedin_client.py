"""LinkedIn official API wrapper stub — no scraping."""


class LinkedInClient:
    def import_contacts_from_csv(self, csv_path: str) -> dict:
        return {
            "status": "stub",
            "message": "Use frontend CSV import or CRM sync.",
            "path": csv_path,
        }
