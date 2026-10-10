package main

import (
	"html/template"
	"net/http"
)

var tplLogin = template.Must(template.New("login").Parse(`<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>OneBrowser 测试站 - 登录</title>
<style>
body{font-family:system-ui,sans-serif;max-width:420px;margin:80px auto;padding:0 16px;color:#222}
h1{font-size:20px} .card{border:1px solid #ddd;border-radius:8px;padding:24px}
input{width:100%;padding:8px;margin:6px 0;box-sizing:border-box}
button{padding:8px 18px;margin-top:8px}
.err{color:#c0392b;font-size:14px}
.note{color:#666;font-size:12px;margin-top:16px;line-height:1.6}
</style></head><body>
<h1>OneBrowser 测试站</h1>
<div class="card">
  <form method="post" action="/login">
    <label>用户名（任意非空即可）</label>
    <input name="user" placeholder="例如 alice" autofocus>
    <label>密码（可留空）</label>
    <input name="pass" type="password">
    {{with .Error}}<p class="err">{{.}}</p>{{end}}
    <button type="submit">登录</button>
  </form>
</div>
<p class="note">登录后本站会设置三种 cookie（HttpOnly 持久 sid / JS 可读 token / 会话级 short）并写入 localStorage。<br>
工具页：<a href="/sessions">会话管理台</a> · <a href="/fp">指纹回显</a></p>
</body></html>`))

var tplApp = template.Must(template.New("app").Parse(`<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>已登录 - OneBrowser 测试站</title>
<style>
body{font-family:system-ui,sans-serif;max-width:640px;margin:60px auto;padding:0 16px;color:#222}
h1{font-size:20px} .box{border:1px solid #ddd;border-radius:8px;padding:16px;margin:12px 0}
table{border-collapse:collapse;font-size:14px}td,th{border:1px solid #eee;padding:4px 10px;text-align:left}
code{background:#f6f6f6;padding:1px 5px;border-radius:3px;font-size:12px}
a{margin-right:12px}
</style></head><body>
<h1>你好，{{.User}} 👋（已登录）</h1>
<div class="box"><strong>会话信息</strong>
<table>
<tr><th>sid (HttpOnly)</th><td><code>{{.SID}}</code></td></tr>
<tr><th>登录时间</th><td>{{.LoginAt.Format "2006-01-02 15:04:05"}}</td></tr>
<tr><th>最近 IP / UA</th><td>{{.IP}} · {{.UA}}</td></tr>
</table></div>
<div class="box"><strong>客户端存储（浏览器侧）</strong>
<ul id="storage"><li>读取中…</li></ul></div>
<p><a href="/sessions">会话管理台</a><a href="/fp">指纹回显</a><a href="/logout">退出登录</a></p>
<script>
// 首次访问写入 localStorage 持久标记（模拟站点本地状态）
if (!localStorage.getItem('theme_token')) {
  localStorage.setItem('theme_token', 'tok-' + Math.random().toString(36).slice(2, 10));
}
sessionStorage.setItem('tmp', 'visited');
document.getElementById('storage').innerHTML =
  '<li>document.cookie: <code>' + document.cookie + '</code></li>' +
  '<li>localStorage.theme_token: <code>' + localStorage.getItem('theme_token') + '</code></li>' +
  '<li>localStorage keys: <code>' + Object.keys(localStorage).join(',') + '</code></li>';
</script>
</body></html>`))

var tplSessions = template.Must(template.New("sessions").Parse(`<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>会话管理台 - OneBrowser 测试站</title>
<style>
body{font-family:system-ui,sans-serif;max-width:860px;margin:60px auto;padding:0 16px;color:#222}
h1{font-size:20px} table{border-collapse:collapse;width:100%;font-size:13px}
td,th{border:1px solid #eee;padding:6px 10px;text-align:left}tr.expired{opacity:.45;text-decoration:line-through}
code{background:#f6f6f6;padding:1px 5px;border-radius:3px;font-size:12px}
.badge{padding:2px 8px;border-radius:10px;background:#eef;color:#335}
form{display:inline}
</style></head><body>
<h1>会话管理台 <span class="badge">IP 绑定校验：{{if .BindIP}}开{{else}}关{{end}}</span></h1>
<p>工具：POST /api/expire?sid=xxx 或 all · POST /api/bind-ip?on=1（换 IP 即失效，模拟风控）</p>
<table><tr><th>sid</th><th>用户</th><th>IP</th><th>UA</th><th>登录时间</th><th>最近活跃</th><th>状态</th></tr>
{{range .Sessions}}
<tr class="{{if .Expired}}expired{{end}}">
<td><code>{{.SID}}</code></td><td>{{.User}}</td><td>{{.IP}}</td>
<td title="{{.UA}}">{{slice .UA 0 30}}…</td>
<td>{{.LoginAt.Format "15:04:05"}}</td><td>{{.LastSeen.Format "15:04:05"}}</td>
<td>{{if .Expired}}已失效{{else}}活跃{{end}}</td></tr>
{{end}}</table>
<p><a href="/">首页</a></p>
</body></html>`))

var tplFP = template.Must(template.New("fp").Parse(`<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>指纹回显 - OneBrowser 测试站</title>
<style>
body{font-family:system-ui,sans-serif;max-width:640px;margin:60px auto;padding:0 16px;color:#222}
h1{font-size:20px} table{border-collapse:collapse;font-size:13px}
td,th{border:1px solid #eee;padding:5px 10px;text-align:left}code{font-size:12px;background:#f6f6f6;padding:1px 5px}
</style></head><body>
<h1>指纹回显页（M5 指纹一致性测试用）</h1>
<table id="fp"><tr><th>项目</th><th>值</th></tr>
<tr><td>User-Agent(服务端)</td><td><code>{{.UA}}</code></td></tr>
<tr><td>RemoteAddr(服务端)</td><td><code>{{.RemoteAddr}}</code></td></tr>
</table>
<script>
function djb2(s){let h=5381;for(let i=0;i<s.length;i++){h=((h<<5)+h+s.charCodeAt(i))|0}return (h>>>0).toString(16)}
// canvas 指纹
const cv=document.createElement('canvas');cv.width=220;cv.height=40;const ctx=cv.getContext('2d');
ctx.textBaseline='top';ctx.font='16px Arial';ctx.fillStyle='#f60';ctx.fillRect(10,5,80,20);
ctx.fillStyle='#069';ctx.fillText('OneBrowser,fp',15,10);ctx.fillStyle='rgba(102,204,0,.7)';ctx.fillText('OneBrowser,fp',15,20);
const canvasHash=djb2(cv.toDataURL());
// webgl 指纹
let glVendor='-',glRenderer='-',glVer='-';
try{const gl=document.createElement('canvas').getContext('webgl');
const ext=gl.getExtension('WEBGL_debug_renderer_info');
glVendor=ext?gl.getParameter(ext.UNMASKED_VENDOR_WEBGL):gl.getParameter(gl.VENDOR);
glRenderer=ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
glVer=gl.getParameter(gl.VERSION);}catch(e){}
const rows=[
 ['User-Agent(客户端)',navigator.userAgent],['platform',navigator.platform],
 ['language(s)',navigator.language+' | '+navigator.languages.join(',')],
 ['hardwareConcurrency',navigator.hardwareConcurrency],['deviceMemory',navigator.deviceMemory],
 ['screen',screen.width+'x'+screen.height+' @'+devicePixelRatio],
 ['timezone',Intl.DateTimeFormat().resolvedOptions().timeZone],
 ['canvas hash','0x'+canvasHash],['webgl vendor',glVendor],['webgl renderer',glRenderer],['webgl version',glVer],
];
const t=document.getElementById('fp');
rows.forEach(([k,v])=>{const tr=document.createElement('tr');const a=document.createElement('td');a.textContent=k;
const b=document.createElement('td');const c=document.createElement('code');c.textContent=String(v);b.appendChild(c);
tr.appendChild(a);tr.appendChild(b);t.appendChild(tr);});
</script>
</body></html>`))

func render(w http.ResponseWriter, tpl *template.Template, data any) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := tpl.Execute(w, data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}
