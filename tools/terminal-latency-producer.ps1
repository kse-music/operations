param(
    [ValidateSet('http', 'load')][string]$Mode = 'http',
    [int]$Port = 0,
    [string]$Run,
    [string]$StopFile = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

public static class ServerDeckLatencyProducer {
    public static void Run(string mode, int port, string run, string stopFile) {
        if (mode == "load") {
            var clock = Stopwatch.StartNew();
            long count = 0;
            Console.WriteLine("SD_BG_READY_" + run + "_END");
            while (clock.Elapsed.TotalSeconds < 90 && !File.Exists(stopFile)) {
                var batch = new StringBuilder();
                for (int n = 0; n < 20; n++) {
                    batch.Append("\x1b[32mBG ").Append(run).Append(' ').Append(count++)
                        .Append("\x1b[0m request completed status=200 path=/latency-fixture ")
                        .Append(new string('x', 70)).Append("\r\n");
                }
                Console.Write(batch.ToString());
                Console.Out.Flush();
                Thread.Sleep(40);
            }
            Console.WriteLine("SD_BG_END_" + run + "_" + count + "_END");
            return;
        }
        var listener = new TcpListener(IPAddress.Loopback, port);
        listener.Start();
        Console.WriteLine("SD_HTTP_READY_" + run);
        try {
            while (true) {
                using (var client = listener.AcceptTcpClient()) {
                    client.ReceiveTimeout = 5000;
                    using (var stream = client.GetStream()) {
                        var reader = new StreamReader(stream, Encoding.ASCII, false, 1024, true);
                        var request = reader.ReadLine();
                        string header;
                        do { header = reader.ReadLine(); } while (!String.IsNullOrEmpty(header));
                        var target = request.Split(' ')[1].TrimStart('/');
                        if (target == "stop") {
                            var done = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                            stream.Write(done, 0, done.Length);
                            return;
                        }
                        int sequence = Int32.Parse(target);
                        long emitted = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                        Console.WriteLine("SD_LAT_" + run + "_" + sequence + "_" + emitted + "_END");
                        Console.Out.Flush();
                        var body = Encoding.ASCII.GetBytes(emitted.ToString());
                        var response = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: " + body.Length + "\r\nConnection: close\r\n\r\n");
                        stream.Write(response, 0, response.Length);
                        stream.Write(body, 0, body.Length);
                    }
                }
            }
        } finally { listener.Stop(); }
    }
}
'@
[ServerDeckLatencyProducer]::Run($Mode, $Port, $Run, $StopFile)
