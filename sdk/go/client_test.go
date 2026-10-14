package jasmine

import (
 "context"
 "encoding/json"
 "net/http"
 "net/http/httptest"
 "testing"
 "time"
)
func TestExecuteHeadersAndPayload(t *testing.T){
 server:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){if r.Header.Get("Authorization")!="Bearer key"||r.Header.Get("Idempotency-Key")!="once"||r.Header.Get("X-Bypass-Cache")!="True"{t.Errorf("missing execution headers")};var body map[string]any;if e:=json.NewDecoder(r.Body).Decode(&body);e!=nil{t.Error(e)};if body["mode"]!="async"||body["version"]!="v1"{t.Errorf("wrong options: %#v",body)};w.Header().Set("Content-Type","application/json");w.Write([]byte(`{"status":"success","requestId":"run","output":{"message":"hello"}}`))}));defer server.Close()
 client:=Client{Endpoint:server.URL,APIKey:"key"};r,e:=client.Execute(context.Background(),"flow",map[string]string{"message":"hello"},ExecuteOptions{Mode:"async",Version:"v1",IdempotencyKey:"once",BypassCache:true});if e!=nil||r.Status!="success"||r.RequestID!="run"{t.Fatalf("result %#v error %v",r,e)}
}
func TestWaitHonorsContext(t *testing.T){server:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){w.Write([]byte(`{"status":"in-progress","requestId":"run"}`))}));defer server.Close();c:=Client{Endpoint:server.URL};ctx,cancel:=context.WithTimeout(context.Background(),20*time.Millisecond);defer cancel();if _,e:=c.Wait(ctx,"run",time.Second);e==nil{t.Fatal("expected deadline error")}}
func TestHTTPFailure(t *testing.T){server:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){w.WriteHeader(403);w.Write([]byte("denied"))}));defer server.Close();c:=Client{Endpoint:server.URL};if _,e:=c.Status(context.Background(),"run");e==nil{t.Fatal("expected HTTP error")}}
func TestFailedRunCarriesError(t *testing.T){server:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){w.Header().Set("Content-Type","application/json");w.Write([]byte(`{"status":"failed","requestId":"run","statusCode":400,"error":{"code":"BAD_PAYLOAD","message":"Invalid trigger payload: $.email: is required","retryable":false,"nodeId":"triggerNode_1"},"message":"Invalid trigger payload: $.email: is required"}`))}));defer server.Close();c:=Client{Endpoint:server.URL};r,e:=c.Execute(context.Background(),"flow",map[string]any{},ExecuteOptions{});if e!=nil{t.Fatal(e)};if r.Error==nil||r.Error.Code!="BAD_PAYLOAD"||r.Error.NodeID!="triggerNode_1"||r.Error.Retryable||r.Message!=r.Error.Message||r.StatusCode!=400{t.Fatalf("error details lost: %#v %#v",r,r.Error)}}
