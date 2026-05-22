import { Container } from "@/helpers/container";
import { Environment } from "@/internal/environment";

import "./globals.css";

const e = Container.inject(Environment);

e.init();

export default (props: React.PropsWithChildren) => {
  return (
    <html lang="en" className={`h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        {e.status.type === "ready" ? props.children : <h1>{e.status.type.toUpperCase()}</h1>}
      </body>
    </html>
  );
};
