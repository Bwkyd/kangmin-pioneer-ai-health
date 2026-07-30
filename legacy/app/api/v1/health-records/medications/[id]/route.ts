import { healthRecordsApi } from "@/lib/health-records/api";
type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, context: Context) { return healthRecordsApi.updateMedication(request, (await context.params).id); }
export async function DELETE(request: Request, context: Context) { return healthRecordsApi.deleteMedication(request, (await context.params).id); }
