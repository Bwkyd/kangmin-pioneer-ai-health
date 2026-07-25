import { healthRecordsApi } from "@/lib/health-records/api";
type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, context: Context) { return healthRecordsApi.updateExposure(request, (await context.params).id); }
export async function PUT(request: Request, context: Context) { return healthRecordsApi.updateExposure(request, (await context.params).id); }
export async function DELETE(request: Request, context: Context) { return healthRecordsApi.deleteExposure(request, (await context.params).id); }
