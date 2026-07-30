import { healthRecordsApi } from "@/lib/health-records/api";

type Context = { params: Promise<{ date: string }> };

export async function PUT(request: Request, context: Context) {
  return healthRecordsApi.saveSymptom(request, (await context.params).date);
}

export async function PATCH(request: Request, context: Context) {
  return healthRecordsApi.saveSymptom(request, (await context.params).date);
}
