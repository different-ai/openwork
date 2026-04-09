import { jsonResponse, rateLimitFormRequest, validateAntiSpamFields, validateTrustedOrigin, verifyFormBotProtection } from "../../_lib/security";
import { APP_FEEDBACK_ATTACHMENT_CONTENT_TYPES, APP_FEEDBACK_ATTACHMENT_MAX_BYTES, createUploadThingApi, getUploadThingToken } from "../_lib/attachments";

export async function POST(request: Request) {
  const originCheck = validateTrustedOrigin(request);
  if (!originCheck.ok) {
    return jsonResponse(request, { error: originCheck.error }, originCheck.status);
  }

  const rateLimit = rateLimitFormRequest(request, "app-feedback-upload");
  if (!rateLimit.ok) {
    return jsonResponse(request, { error: "Image upload is temporarily rate limited." }, 429);
  }

  const botProtection = await verifyFormBotProtection();
  if (!botProtection.ok) {
    return jsonResponse(request, { error: botProtection.error }, botProtection.status);
  }

  const token = getUploadThingToken();
  if (!token) {
    return jsonResponse(
      request,
      { error: "Image uploads are not configured on this deployment." },
      500,
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse(request, { error: "Invalid upload payload." }, 400);
  }

  const antiSpam = validateAntiSpamFields({
    website: typeof formData.get("website") === "string" ? String(formData.get("website")) : "",
    startedAt:
      typeof formData.get("startedAt") === "string"
        ? String(formData.get("startedAt"))
        : "",
  });
  if (!antiSpam.ok) {
    return jsonResponse(request, { error: antiSpam.error }, antiSpam.status);
  }

  const image = formData.get("image");
  if (!(image instanceof File)) {
    return jsonResponse(request, { error: "Please choose an image to upload." }, 400);
  }

  if (!APP_FEEDBACK_ATTACHMENT_CONTENT_TYPES.has(image.type)) {
    return jsonResponse(
      request,
      { error: "Only PNG, JPG, and WebP screenshots are supported." },
      400,
    );
  }

  if (image.size <= 0 || image.size > APP_FEEDBACK_ATTACHMENT_MAX_BYTES) {
    return jsonResponse(
      request,
      { error: "Screenshots must be smaller than 8 MB." },
      400,
    );
  }

  try {
    const result = await createUploadThingApi(token).uploadFiles(image, {
      acl: "public-read",
      contentDisposition: "inline",
    });

    if (result.error || !result.data) {
      return jsonResponse(
        request,
        { error: result.error?.message ?? "Failed to upload screenshot." },
        502,
      );
    }

    return jsonResponse(request, {
      attachment: {
        name: result.data.name || image.name,
        fileKey: result.data.key,
        accessUrl: result.data.url,
        size: result.data.size || image.size,
        contentType: image.type,
      },
    });
  } catch (error) {
    return jsonResponse(
      request,
      {
        error:
          error instanceof Error
            ? error.message
            : "Something went wrong while uploading the screenshot.",
      },
      502,
    );
  }
}
