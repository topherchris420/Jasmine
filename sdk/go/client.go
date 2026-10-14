// Package jasmine provides a dependency-free client for a local Jasmine server.
package jasmine

import (
 "bytes"
 "context"
 "encoding/json"
 "fmt"
 "io"
 "net/http"
 "net/url"
 "strings"
 "time"
)

type Client struct { Endpoint, APIKey, ProjectID string; HTTP *http.Client }
type Run struct { Status string `json:"status"`; RequestID string `json:"requestId"`; Output json.RawMessage `json:"output"`; Result json.RawMessage `json:"result"`; Version string `json:"version"`; Cached bool `json:"cached"` }
type ExecuteOptions struct { Mode, IdempotencyKey, Version string; BypassCache bool }

func (c *Client) request(ctx context.Context, method, path string, body any, headers map[string]string, result any) error {
 var data io.Reader
 if body != nil { b,e:=json.Marshal(body); if e!=nil{return e};data=bytes.NewReader(b) }
 endpoint:=strings.TrimRight(c.Endpoint,"/");if endpoint==""{endpoint="http://127.0.0.1:8787"}
 req,e:=http.NewRequestWithContext(ctx,method,endpoint+path,data);if e!=nil{return e}
 if body!=nil{req.Header.Set("Content-Type","application/json")};if c.APIKey!=""{req.Header.Set("Authorization","Bearer "+c.APIKey)};if c.ProjectID!=""{req.Header.Set("x-project-id",c.ProjectID)};for k,v:=range headers{req.Header.Set(k,v)}
 client:=c.HTTP;if client==nil{client=&http.Client{Timeout:120*time.Second}}
 response,e:=client.Do(req);if e!=nil{return e};defer response.Body.Close()
 if response.StatusCode<200||response.StatusCode>=300{b,_:=io.ReadAll(io.LimitReader(response.Body,8192));return fmt.Errorf("Jasmine HTTP %d: %s",response.StatusCode,string(b))}
 return json.NewDecoder(response.Body).Decode(result)
}
func(c *Client) Execute(ctx context.Context, flowID string, payload any, opts ExecuteOptions)(Run,error){
 mode:=opts.Mode;if mode==""{mode="realtime"};body:=map[string]any{"payload":payload,"mode":mode};if opts.Version!=""{body["version"]=opts.Version};headers:=map[string]string{};if opts.IdempotencyKey!=""{headers["Idempotency-Key"]=opts.IdempotencyKey};if opts.BypassCache{headers["X-Bypass-Cache"]="True"}
 var r Run;e:=c.request(ctx,"POST","/api/v1/flows/"+url.PathEscape(flowID)+"/execute",body,headers,&r);return r,e
}
func(c *Client) Status(ctx context.Context,id string)(Run,error){var r Run;e:=c.request(ctx,"GET","/api/v1/runs/"+url.PathEscape(id),nil,nil,&r);return r,e}
func(c *Client) Wait(ctx context.Context,id string,interval time.Duration)(Run,error){if interval<=0{interval=250*time.Millisecond};for{r,e:=c.Status(ctx,id);if e!=nil||r.Status!="in-progress"{return r,e};timer:=time.NewTimer(interval);select{case<-ctx.Done():timer.Stop();return Run{},ctx.Err();case<-timer.C:}}}
func(c *Client) Cancel(ctx context.Context,id string)(bool,error){var r struct{Cancelled bool `json:"cancelled"`};e:=c.request(ctx,"POST","/api/v1/runs/"+url.PathEscape(id)+"/cancel",map[string]any{},nil,&r);return r.Cancelled,e}
func(c *Client) Retry(ctx context.Context,id string)(Run,error){var r Run;e:=c.request(ctx,"POST","/api/v1/runs/"+url.PathEscape(id)+"/retry",map[string]any{},nil,&r);return r,e}
