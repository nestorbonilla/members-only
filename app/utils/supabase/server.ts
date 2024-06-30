import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';

const createClient = () => {
  const cookieStore = cookies();

  return createServerClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value, ...options });
          } catch (error) {
            // The `set` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing
            // user sessions.
          }
        },
        remove(name: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value: '', ...options });
          } catch (error) {
            // The `delete` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing
            // user sessions.
          }
        },
      },
    }
  );
};

export const getChannelRules = async (channelId: string) => {
  const client = createClient();
  const { data, error } = await client
    .from('channel_access_rules')
    .select('*')
    .eq('channel_id', channelId)
    .order('created_at', { ascending: false })
    .limit(parseInt(process.env.ACCESS_RULES_LIMIT!));
  if (error) {
    console.error('Error fetching channel access rules:', error);
    throw error; // Rethrow the error for handling in the API route
  }
  return data;
};

export const doesRuleWithContractExist = async (
  channelId: string,
  contractAddress: string
) => {
  const client = createClient();
  try {
    const { data, error } = await client
      .from('channel_access_rules')
      .select('id') // Only select the id column, for efficiency
      .eq('channel_id', channelId)
      .eq('contract_address', contractAddress)
      .maybeSingle(); // Return a single row or null

    if (error) {
      // Handle the error gracefully, perhaps by logging and returning false
      console.error('Error checking for duplicate rule:', error);
      return false;
    }

    return !!data; // If a row is found (data not null), return true, otherwise false
  } catch (error) {
    // Handle unexpected errors
    console.error('Unexpected error checking for duplicate rule:', error);
    return false; // It's generally safer to return false in case of an error
  }
};

export const insertChannelRule = async (
  channelId: string,
  network: string,
  contractAddress: string,
  operator: string,
  ruleBehavior: string
) => {
  const client = createClient();

  const { error } = await client.from('channel_access_rules').insert([
    {
      channel_id: channelId,
      operator: operator,
      rule_behavior: ruleBehavior,
      network: network,
      contract_address: contractAddress,
    },
  ]);

  return error;
};

export const deleteChannelRule = async (
  channelId: string,
  contractAddress: string
) => {
  const client = createClient();

  const { error } = await client
    .from('channel_access_rules')
    .delete()
    .eq('channel_id', channelId)
    .eq('contract_address', contractAddress);

  return error; // Return the error object (or null if successful)
};
