import Foundation

public struct HelperFailure: Error, Codable, LocalizedError, Sendable {
    public let code: String
    public let message: String
    public init(_ code: String, _ message: String) { self.code = code; self.message = message }
    public var errorDescription: String? { message }
}

public enum HelperLimits {
    public static let pngBytes = 1024 * 1024
    public static let frameBytes = 2 * 1024 * 1024
    public static let receipts = 4096
}

public enum ConfirmationMode: String, Codable, Sendable {
    case native
    case aiClient = "ai_client"
}

public struct HelperRequest: Decodable {
    public let version: Int
    public let request_id: UUID
    public let method: String
    public let job_id: UUID?
    public let device_id: UUID?
    public let png_base64: String?
    public let paper_approved: Bool?
    public let expected_confirmation_mode: ConfirmationMode?

    public static func decode(_ data: Data) throws -> HelperRequest {
        guard data.count <= HelperLimits.frameBytes,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys).isSubset(of: ["version", "request_id", "method", "job_id", "device_id", "png_base64", "paper_approved", "expected_confirmation_mode"]),
              let value = try? JSONDecoder().decode(HelperRequest.self, from: data),
              value.version == 1 else {
            throw HelperFailure("invalid_request", "Expected bounded protocol-v1 JSON with a UUID request_id and known fields.")
        }
        var keys: Set<String>
        switch value.method {
        case "helper_status": keys = ["version", "request_id", "method"]
        case "inspect_png": keys = ["version", "request_id", "method", "png_base64"]
        case "submit_png": keys = ["version", "request_id", "method", "job_id", "device_id", "png_base64", "paper_approved"]
        case "job_status", "cancel_job": keys = ["version", "request_id", "method", "job_id"]
        default: throw HelperFailure("unknown_method", "Unsupported helper method.")
        }
        if value.method == "submit_png", object.keys.contains("expected_confirmation_mode") {
            guard value.expected_confirmation_mode != nil else {
                throw HelperFailure("invalid_request", "Expected confirmation mode must be native or ai_client.")
            }
            keys.insert("expected_confirmation_mode")
        }
        guard Set(object.keys) == keys else {
            throw HelperFailure("invalid_request", "Missing or inapplicable method fields.")
        }
        return value
    }
}

public struct ImageInspection: Codable, Sendable {
    public let sha256: String
    public let width: Int
    public let height: Int
    public let png_bytes: Int
    public let raster_bands: Int
    public let clearance_dots: Int
}

public struct JobReceipt: Codable, Sendable {
    public let job_id: UUID
    public let device_id: UUID
    public let image_sha256: String
    public let height: Int
    public let instance_id: UUID
    public var state: String
    public var message: String
    public var error_code: String?
    public let created_at: Date
    public var updated_at: Date
    public var paper_confirmed = false
    public var outcome_acknowledged: Bool? = false
    public var confirmation_mode: ConfirmationMode?
}

public struct HelperHealth: Codable, Sendable {
    public let bluetooth: String
    public let active_job_id: UUID?
    public let safety_blocked: Bool
    public let unresolved_job_ids: [UUID]
    public let confirmation_mode: ConfirmationMode
    public let confirmation_preference_error: HelperFailure?
    public let message: String
    public var supports_expected_confirmation_mode: Bool? = true
}

enum HelperJSON {
    static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }
    static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { value in
            let container = try value.singleValueContainer()
            if let seconds = try? container.decode(Double.self) {
                return Date(timeIntervalSinceReferenceDate: seconds)
            }
            let string = try container.decode(String.self)
            guard let date = ISO8601DateFormatter().date(from: string) else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid receipt timestamp")
            }
            return date
        }
        return decoder
    }
}

public struct HelperResult: Codable, Sendable {
    public var health: HelperHealth?
    public var image: ImageInspection?
    public var receipt: JobReceipt?
    public var preview_png_base64: String?
    public init(health: HelperHealth? = nil, image: ImageInspection? = nil, receipt: JobReceipt? = nil, preview_png_base64: String? = nil) {
        self.health = health; self.image = image; self.receipt = receipt; self.preview_png_base64 = preview_png_base64
    }
}

public struct HelperReply: Codable, Sendable {
    public let version: Int
    public let request_id: UUID?
    public let ok: Bool
    public let result: HelperResult?
    public let error: HelperFailure?
    public init(id: UUID?, result: HelperResult) {
        version = 1; request_id = id; ok = true; self.result = result; error = nil
    }
    public init(id: UUID?, error: HelperFailure) {
        version = 1; request_id = id; ok = false; result = nil; self.error = error
    }
}
