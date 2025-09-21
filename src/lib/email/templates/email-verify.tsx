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

export interface EmailVerifyProps {
  fullUrl: string;
  name: string;
}

export const EmailVerifySubject = "Verify your email" as const;

export const EmailVerify: React.FC<EmailVerifyProps> = ({ fullUrl, name }) => {
  return (
    <Html>
      <Head />
      <Tailwind>
        <Body style={{ fontFamily: "sans-serif" }}>
          <Preview>Please verify your email</Preview>
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
                      Verify your email
                    </Heading>
                    <Text className="m-0 mt-[8px] text-[16px] leading-[24px] text-white">
                      Please click the button below to verify your email address.
                    </Text>
                    <Button
                      className="mt-[24px] rounded-[8px] border border-solid border-gray-200 bg-white px-[40px] py-[12px] font-semibold text-gray-900"
                      href={fullUrl}
                    >
                      Verify
                    </Button>

                    {/* footer */}
                    <Hr className="my-[16px] mt-[32px] !border-gray-300" />
                    <Section className="text-center">
                      <Heading as="h3" className="m-[0px] text-[14px] leading-[20px] font-medium text-gray-200">
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
