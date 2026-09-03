package internal

import (
	"log/slog"
	"net/http"

	"golang.org/x/net/webdav"
)

// expose wraps a webdav.Handler to provide access control and structured logging.
type expose struct {
	id       string
	password string
	dir      string
	clientIP string
	handler  webdav.Handler
}

// serveHTTP forwards incoming HTTP requests directly to the underlying WebDAV handler.
// Access control is decoupled and assumed to be validated prior to hitting this handler.
func (e *expose) serveHTTP(w http.ResponseWriter, r *http.Request) {

	// Excerpt from RFC4918, section 9.4:
	//
	// 		GET, when applied to a collection, may return the contents of an
	//		"index.html" resource, a human-readable view of the contents of
	//		the collection, or something else altogether.
	//
	//    Similarly, since the definition of HEAD is a GET without a response
	// 		message body, the semantics of HEAD are unmodified when applied to
	// 		collection resources.
	//
	// GET (or HEAD), when applied to collection, will return the same as PROPFIND method.
	if r.Method == "GET" || r.Method == "HEAD" {
		if info, err := e.handler.FileSystem.Stat(r.Context(), e.dir + r.URL.Path); err == nil && info.IsDir() {
			r.Method = "PROPFIND"

			if r.Header.Get("Depth") == "" {
				r.Header.Add("Depth", "1")
			}
		}
	}

	e.handler.ServeHTTP(w, r)
}

// newExpose instantiates a new Expose instance configured with the given credentials,
// a local root directory path mapping, and a structured logger.
func newExpose(id, password, dir, clientIP string, logger *slog.Logger) *expose {
	return &expose{
		id:       id,
		password: password,
		dir:      dir,
		clientIP: clientIP,
		handler: webdav.Handler{
			FileSystem: webdav.Dir(dir),
			LockSystem: webdav.NewMemLS(),
			Logger: func(r *http.Request, err error) {
				if err != nil {
					logger.Error("webdav request failure",
						slog.Group("request",
							slog.String("method", r.Method),
							slog.String("path", r.URL.Path),
						),
						slog.Any("error", err),
					)
				} else {
					logger.Info("webdav request success",
						slog.Group("request",
							slog.String("id", id),
							slog.String("method", r.Method),
							slog.String("path", r.URL.Path),
						),
					)
				}
			},
		},
	}
}
