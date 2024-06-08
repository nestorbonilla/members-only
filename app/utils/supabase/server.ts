import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'

const createClient = () => {
  const cookieStore = cookies();

  return createServerClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value
        },
        set(name: string, value: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value, ...options })
          } catch (error) {
            // The `set` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing
            // user sessions.
          }
        },
        remove(name: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value: '', ...options })
          } catch (error) {
            // The `delete` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing
            // user sessions.
          }
        },
      },
    }
  )
}

export const getChannelRules = async (channelId: string, limit: number = 3) => {
  const client = createClient(); // Create the Supabase client
  const { data, error } = await client
    .from('channel_access_rules')
    .select('*')
    .eq('channel_id', channelId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('Error fetching channel access rules:', error);
    throw error; // Rethrow the error for handling in the API route
  }
  return data;
}

export const insertChannelRule = async (
  channelId: string,
  network: string,
  contractAddress: string,
  operator: string,
  ruleBehavior: string
) => {
  const client = createClient();

  const { error } = await client
    .from('channel_access_rules')
    .insert([
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