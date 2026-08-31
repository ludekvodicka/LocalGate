import dns from "node:dns";

class LocalgateNodeBootstrap
{
  static install()
  {
    const originalLookup = dns.lookup.bind(dns);

    // Browsers reserve *.localhost for loopback, but some system resolvers used by Node do not.
    dns.lookup = (hostname, options, callback) =>
    {
      if (typeof hostname != "string" || !hostname.toLowerCase().endsWith(".localhost"))
      {
        if (typeof options == "function") return originalLookup(hostname, options);
        return originalLookup(hostname, options, callback);
      }

      const done = typeof options == "function" ? options : callback;
      if (typeof done != "function") return originalLookup(hostname, options, callback);

      if (typeof options == "object" && options?.all === true)
        return process.nextTick(done, null, [{ address: "127.0.0.1", family: 4 }]);

      return process.nextTick(done, null, "127.0.0.1", 4);
    };
  }
}

LocalgateNodeBootstrap.install();
