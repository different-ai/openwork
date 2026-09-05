import { NextRequest } from "next/server";
import { redirectToDenApi } from "../../_lib/den-api-redirect";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function redirect(request: NextRequest, segments: string[] = []) {
  void segments;
  return redirectToDenApi(request, "/api/den");
}

export async function GET(request: NextRequest) {
  return redirect(request);
}

export async function HEAD(request: NextRequest) {
  return redirect(request);
}

export async function POST(request: NextRequest) {
  return redirect(request);
}

export async function PUT(request: NextRequest) {
  return redirect(request);
}

export async function PATCH(request: NextRequest) {
  return redirect(request);
}

export async function DELETE(request: NextRequest) {
  return redirect(request);
}

export async function OPTIONS(request: NextRequest) {
  return redirect(request);
}
