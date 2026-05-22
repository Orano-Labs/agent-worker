import { Container } from "@/helpers/container";
import { Environment } from "@/internal/environment";

const env = Container.inject(Environment);

export default () => {
  return <pre>{JSON.stringify(env.status, null, 2)}</pre>;
};
