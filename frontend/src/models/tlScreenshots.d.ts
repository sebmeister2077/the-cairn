/**
 * Frontend types for screenshot-based TL contributions.
 * Mirrors backend `app.routes.contribute_tls_screenshots._serialise_request`.
 */

export type TLScreenshotStatus = "pending" | "approved" | "rejected" | "withdrawn";
export type TLScreenshotAnalysisStatus = "queued" | "running" | "done" | "failed";

export interface TLScreenshotOCR {
    x: number | null;
    y: number | null;
    z: number | null;
    raw_text: string;
    confidence: number;
}

export interface TLScreenshotCoords {
    x: number | null;
    y: number | null;
    z: number | null;
}

export interface TLScreenshotMinimapMatch {
    score: number;
    method: string;
    chunks_used: number;
    scale: number | null;
    sampled_window: { x_min: number; x_max: number; z_min: number; z_max: number } | null;
}

export interface TLScreenshotValidationWarning {
    code: string;
    severity: "info" | "warning" | "error";
    message: string;
}

export interface TLScreenshotRequest {
    id: string;
    status: TLScreenshotStatus;
    analysis_status: TLScreenshotAnalysisStatus;
    analysis_error: string | null;
    submitter_api_key_id: string | null;
    submitter_display_name: string | null;
    label: string | null;
    ocr_a: TLScreenshotOCR | null;
    ocr_b: TLScreenshotOCR | null;
    coords_a: TLScreenshotCoords | null;
    coords_b: TLScreenshotCoords | null;
    validation_warnings: TLScreenshotValidationWarning[];
    minimap_match: { a: TLScreenshotMinimapMatch; b: TLScreenshotMinimapMatch } | null;
    decision_actor_api_key_id: string | null;
    decision_reason: string | null;
    decision_at: string | null;
    resulting_segment_id: string | null;
    screenshot_a_taken_at: string | null;
    screenshot_b_taken_at: string | null;
    created_at: string;
    updated_at: string;
    // Only present in admin / detail responses.
    screenshot_a_url?: string | null;
    screenshot_b_url?: string | null;
    minimap_a_url?: string | null;
    minimap_b_url?: string | null;
    // Stitched & cropped level-5 server-map window the analysis worker
    // matched the minimap crop against. Null when the area is unexplored
    // on the server map (no chunks available).
    server_minimap_a_url?: string | null;
    server_minimap_b_url?: string | null;
}

export interface TLScreenshotUploadUrlResponse {
    request_id: string;
    upload_url_a: string;
    upload_url_b: string;
    screenshot_a_key: string;
    screenshot_b_key: string;
    expires_in: number;
}
