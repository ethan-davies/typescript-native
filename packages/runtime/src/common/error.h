#ifndef SN_ERROR_H
#define SN_ERROR_H

#ifdef __cplusplus
extern "C" {
#endif

/* Portable error code tags (interim; map to language Error subclasses later). */
#define SN_ERR_FILE_NOT_FOUND "FileNotFound"
#define SN_ERR_PERMISSION_DENIED "PermissionDenied"
#define SN_ERR_CONNECTION_REFUSED "ConnectionRefused"
#define SN_ERR_CONNECTION_RESET "ConnectionReset"
#define SN_ERR_TIMEOUT "Timeout"
#define SN_ERR_DNS_FAILURE "DnsFailure"
#define SN_ERR_TLS_ERROR "TlsError"

/* Map errno to sn_error_new with message "context: strerror". */
void *sn_error_from_errno(int err, const char *context);

/* Interim helper; code is a portable string tag (e.g. SN_ERR_TIMEOUT). */
void *sn_error_from_code(const char *code, const char *message);

#ifdef __cplusplus
}
#endif

#endif /* SN_ERROR_H */
