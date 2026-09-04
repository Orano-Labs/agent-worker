package internal

import (
	"log/slog"
	"net"
	"net/http"
	"path/filepath"
	"sync"

	"github.com/gin-gonic/gin"
)

type controller struct {
	exposes         map[string]*expose
	internalHandler http.Handler
	logger          *slog.Logger
	mu              sync.RWMutex
	root            string
}

func (c *controller) serveExternal(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("WWW-Authenticate", `Basic realm="webdav"`)

	username, password, ok := r.BasicAuth()

	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	c.mu.RLock()
	expose, ok := c.exposes[username]
	c.mu.RUnlock()

	if !ok || expose.password != password {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	if expose.clientIP != "" && clientIP(r) != expose.clientIP {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	expose.handler.ServeHTTP(w, r)
}

func (c *controller) serveInternal(w http.ResponseWriter, r *http.Request) {
	c.internalHandler.ServeHTTP(w, r)
}

func newController(root string, logger *slog.Logger) *controller {
	gin.SetMode(gin.ReleaseMode)

	c := &controller{
		exposes: make(map[string]*expose),
		logger:  logger,
		root:    root,
	}

	router := gin.New()
	router.Use(gin.Recovery())

	router.POST("/expose/:id", func(ctx *gin.Context) {
		id := ctx.Param("id")
		password := ctx.PostForm("password")
		dir := ctx.PostForm("dir")
		cip := ctx.PostForm("client_ip")

		if id == "" || password == "" || dir == "" || cip == "" {
			logger.Warn("invalid expose create request",
				slog.String("id", id),
				slog.String("dir", dir),
				slog.String("client_ip", cip),
			)

			ctx.JSON(http.StatusBadRequest, gin.H{
				"error": "bad request",
			})
			return
		}

		c.mu.Lock()
		defer c.mu.Unlock()

		if _, exists := c.exposes[id]; exists {
			logger.Warn("expose already exists",
				slog.String("id", id),
			)

			ctx.JSON(http.StatusConflict, gin.H{
				"error": "expose already exists",
			})
			return
		}

		dir = filepath.Clean("/" + dir)
		dir = filepath.Join(c.root, dir)

		c.exposes[id] = newExpose(id, password, dir, cip, logger)

		logger.Info("expose created",
			slog.String("id", id),
			slog.String("dir", dir),
			slog.String("client_ip", cip),
		)

		ctx.JSON(http.StatusOK, gin.H{
			"status": "created",
			"id":     id,
		})
	})

	router.GET("/expose", func(ctx *gin.Context) {
		c.mu.RLock()
		defer c.mu.RUnlock()

		ids := make([]string, 0, len(c.exposes))
		for id := range c.exposes {
			ids = append(ids, id)
		}

		ctx.JSON(http.StatusOK, gin.H{
			"exposes": ids,
		})
	})

	router.DELETE("/expose/:id", func(ctx *gin.Context) {
		id := ctx.Param("id")

		c.mu.Lock()
		defer c.mu.Unlock()

		if _, ok := c.exposes[id]; !ok {
			logger.Warn("delete non-existing expose",
				slog.String("id", id),
			)

			ctx.JSON(http.StatusNotFound, gin.H{"error": "not found"})
			return
		}

		delete(c.exposes, id)

		logger.Info("expose deleted",
			slog.String("id", id),
		)

		ctx.JSON(http.StatusOK, gin.H{
			"status": "deleted",
			"id":     id,
		})
	})

	c.internalHandler = router

	return c
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)

	if err != nil {
		return r.RemoteAddr
	}

	return host
}
