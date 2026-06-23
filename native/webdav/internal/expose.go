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
	handler  webdav.Handler
}

// serveHTTP forwards incoming HTTP requests directly to the underlying WebDAV handler.
// Access control is decoupled and assumed to be validated prior to hitting this handler.
func (e *expose) serveHTTP(w http.ResponseWriter, r *http.Request) {
	e.handler.ServeHTTP(w, r)
}

// newExpose instantiates a new Expose instance configured with the given credentials,
// a local root directory path mapping, and a structured logger.
func newExpose(id, password, dir string, logger *slog.Logger) *expose {
	return &expose{
		id:       id,
		password: password,
		dir:      dir,
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
