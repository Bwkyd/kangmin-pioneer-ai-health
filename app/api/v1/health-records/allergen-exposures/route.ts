import { healthRecordsApi } from "@/lib/health-records/api";
export const GET = healthRecordsApi.listExposures;
export const POST = healthRecordsApi.createExposure;
