export function classroomFeatureOptions(origin: string, occurrence?: { bookingId: string; occurrenceId: string }, pluginEnabled = false) {
  const enabled = ["presentation", "snapshotOfCurrentSlide", "timer", "sharedNotes", "screenshare", "layouts", "learningDashboard"];
  if (pluginEnabled) enabled.push("plugins");
  const materials = materialsPicker(origin, occurrence);
  return {
    disabledFeaturesExclude: enabled.join(","),
    lockSettingsDisableNotes: false,
    lockSettingsDisableMic: true,
    lockSettingsDisableCam: true,
    lockSettingsLockOnJoin: false,
    lockSettingsLockOnJoinConfigurable: true,
    allowModsToEjectCameras: true,
    presentationUploadExternalUrl: materials?.toString(),
    presentationUploadExternalDescription: occurrence ? "教材库" : undefined,
    pluginManifests: pluginEnabled ? JSON.stringify([{ url: new URL("/classroom-tools/manifest.json", origin).toString() }]) : undefined,
  };
}

function xmlAttribute(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}

export function classroomDocumentXml(name: string, url: string) {
  return `<modules><module name="presentation"><document current="true" downloadable="false" filename="${xmlAttribute(name)}" url="${xmlAttribute(url)}"/></module></modules>`;
}

function materialsPicker(origin: string, occurrence?: { bookingId: string; occurrenceId: string }) {
  if (!occurrence) return null;
  const materials = new URL("/classroom/materials", origin);
  materials.searchParams.set("bookingId", occurrence.bookingId);
  materials.searchParams.set("occurrenceId", occurrence.occurrenceId);
  return materials;
}
