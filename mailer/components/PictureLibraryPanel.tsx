"use client";

import {
  PictureDropdownPicker,
  type PictureDropdownPickerProps,
} from "./PictureDropdownPicker";

export type PictureLibraryPanelProps = PictureDropdownPickerProps;

/**
 * Dropdown picture picker for the Mailer.
 * Full picture library administration (groups, uploads, captions) is now
 * managed inside the Sales Agent (Email templates -> Picture library).
 */
export function PictureLibraryPanel(props: PictureLibraryPanelProps) {
  return <PictureDropdownPicker {...props} />;
}
