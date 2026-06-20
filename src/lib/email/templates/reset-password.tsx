import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Tailwind,
  Text,
} from "@react-email/components";

import { clientEnv } from "~/env/client";

export interface ResetPasswordEmailProps {
  fullUrl: string;
  name: string;
}

export const ResetPasswordSubject = "Reset your password" as const;

export const ResetPasswordEmail: React.FC<ResetPasswordEmailProps> = ({ fullUrl, name }) => {
  return (
    <Html>
      <Head />
      <Tailwind>
        <Body style={{ fontFamily: "sans-serif" }}>
          <Preview>Reset your Zevium.dev password</Preview>
          <Container>
            <table
              align="center"
              border={0}
              cellPadding="0"
              cellSpacing="0"
              className="my-[16px] h-[424px] rounded-[12px] bg-blue-600"
              role="presentation"
              style={{ backgroundSize: "100% 100%" }}
              width="100%"
            >
              <tbody>
                <tr>
                  <td align="center" className="p-[40px] text-center">
                    <Text className="m-0 font-semibold text-gray-200">Hey {name}</Text>
                    <Heading as="h1" className="m-0 mt-[4px] font-bold text-white">
                      Reset your password
                    </Heading>
                    <Text className="m-0 mt-[8px] text-[16px] leading-[24px] text-white">
                      We received a request to reset your Zevium.dev password. Click the button below to create a new
                      one.
                    </Text>
                    <Button
                      className="mt-[24px] rounded-[8px] border border-solid border-gray-200 bg-white px-[40px] py-[12px] font-semibold text-gray-900"
                      href={fullUrl}
                    >
                      Reset password
                    </Button>
                    <Text className="m-0 mt-[12px] text-[14px] leading-[20px] text-gray-200">
                      If you didn&apos;t request this, you can safely ignore this email.
                    </Text>
                    <Hr className="my-[16px] mt-[32px] border-gray-300!" />
                    <Section className="text-center">
                      <Heading as="h3" className="m-0 text-[14px] leading-[20px] font-medium text-gray-200">
                        <Link className="text-inherit" href={clientEnv.VITE_PUBLIC_URL}>
                          Zevium.dev
                        </Link>
                      </Heading>
                    </Section>
                  </td>
                </tr>
              </tbody>
            </table>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
};
