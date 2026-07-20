export function webhookPayloadMatchesJob(webhookPayload: string, jobId: string): boolean {
  try {
    const parsed = JSON.parse(webhookPayload) as { clipId?: unknown; photoResponseId?: unknown };
    const entityIds = [parsed.clipId, parsed.photoResponseId].filter((value) => value !== undefined);
    return entityIds.length > 0 && entityIds.every((value) => value === jobId);
  } catch {
    return false;
  }
}
