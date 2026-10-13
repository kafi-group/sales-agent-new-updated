"""Meta Graph API client stub for Facebook/Instagram DMs."""


class MetaClient:
    def create_dm_draft(self, *, platform: str, recipient_id: str, message: str) -> dict:
        return {
            "status": "stub",
            "message": "Meta Graph API not configured.",
            "platform": platform,
        }
