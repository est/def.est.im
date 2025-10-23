export const prerender = false;

export async function POST({ request }) {
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get('q');
    
    if (!query) {
      return new Response(JSON.stringify({ error: 'No query provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Try to get from static JSON first
    try {
      const staticResponse = await fetch(`/.dict_json/out/${query}.json`);
      if (staticResponse.ok) {
        const data = await staticResponse.json();
        return new Response(JSON.stringify({ result: data }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    } catch (e) {
      // Fallback to other methods
    }

    // For now, return a placeholder response
    // In a real implementation, this would call your word lookup service
    const placeholderData = {
      WORD: query,
      IPA: '',
      CONJUGATES: '',
      ETYMOLOGY: '',
      SINCE: '',
      MEANINGS: [],
      REGISTER: ''
    };

    return new Response(JSON.stringify({ result: placeholderData }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Lookup error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
