// A bounded probe using the same Go http.Transport pool settings documented
// by cloudflared. Not a load test against any deployed service.
package main

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

func main() {
	for _, port := range []int{4101, 4102} {
		var success, failed atomic.Int64
		var wg sync.WaitGroup
		for i := 0; i < 400; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				transport := &http.Transport{
					MaxIdleConns: 100, MaxIdleConnsPerHost: 100,
					IdleConnTimeout: 90 * time.Second,
					TLSHandshakeTimeout: 10 * time.Second,
					ExpectContinueTimeout: time.Second,
					DialContext: (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
				}
				defer transport.CloseIdleConnections()
				client := &http.Client{Transport: transport, Timeout: 10 * time.Second}
				call := func() {
					// A forwarded POST has no GetBody replay callback. Do not add
					// one: unsafe application requests must not be replayed.
					req, err := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d", port), io.NopCloser(strings.NewReader("{}")))
					if err != nil {
						panic(err)
					}
					req.ContentLength = 2
					res, err := client.Do(req)
					if err != nil {
						failed.Add(1)
						return
					}
					_, err = io.Copy(io.Discard, res.Body)
					res.Body.Close()
					if err != nil || res.StatusCode != http.StatusOK {
						failed.Add(1)
					} else {
						success.Add(1)
					}
				}
				call()
				time.Sleep(time.Duration(5950+i%101) * time.Millisecond)
				call()
			}(i)
		}
		wg.Wait()
		fmt.Printf("port=%d success=%d failed=%d\n", port, success.Load(), failed.Load())
	}
}
