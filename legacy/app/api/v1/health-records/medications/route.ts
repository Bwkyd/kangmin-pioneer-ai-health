import { healthRecordsApi } from "@/lib/health-records/api";
export const GET = healthRecordsApi.listMedications;
export const POST = healthRecordsApi.createMedication;
